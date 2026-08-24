#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from statistics import mean
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import load_rows, macro_f1
from robustness import accuracy, none_false_positive_rate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay a deterministic none-safety pre-gate over SetFit robustness predictions.")
    parser.add_argument("--robustness", default=".ax/experiments/setfit-robustness-workflow-fixtures-current.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-with-workflow-fixture-metadata-current.jsonl")
    parser.add_argument("--out", default=".ax/experiments/none-safety-pregate-workflow-fixtures-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def fixture_by_id(path: str) -> dict[str, dict[str, Any]]:
    return {str(row["id"]): row for row in load_rows(path)}


def text_for(row: dict[str, Any]) -> str:
    return f"{row.get('name', '')}\n{row.get('target', '')}\n{row.get('text', '')}".lower()


def contains_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(needle in text for needle in needles)


def none_safety_reason(row: dict[str, Any]) -> str | None:
    text = text_for(row)
    if contains_any(text, ("what was the task i gave you", "what task did i give you", "what did i ask you to do")):
        return "context_recall_question"
    if contains_any(text, ("user:\ncontinue", "user:\ngo", "user:\nalright go")) and contains_any(text, ("already executing", "agreed plan")):
        return "already_executing_continue"
    if contains_any(text, ("whats next", "what's next", "what is next", "what next?")) and contains_any(text, ("completed", "results", "verification", "summary")):
        return "completed_workflow_next_question"
    if contains_any(text, ("how large", "how big", "model size", "download")) and contains_any(text, ("trained model", "model", "artifact", "contributors", "download")):
        return "model_artifact_question"
    if contains_any(text, ("how big is the text", "how large is the text", "how much text", "chunk of the session")) and contains_any(text, ("classify", "classifier", "classification", "sections")):
        return "classifier_capacity_question"
    return None


def source_examples(run: dict[str, Any]) -> list[dict[str, Any]]:
    return list((run.get("calibrated") or {}).get("examples") or run.get("examples") or [])


def apply_none_safety_gate(
    examples: list[dict[str, Any]],
    fixtures: dict[str, dict[str, Any]],
) -> tuple[list[str], list[dict[str, str]]]:
    predictions: list[str] = []
    overrides: list[dict[str, str]] = []
    for example in examples:
        row_id = str(example["id"])
        fixture = fixtures.get(row_id)
        if fixture is None:
            raise ValueError(f"missing fixture for report example: {row_id}")
        original = str(example["predicted"])
        reason = none_safety_reason(fixture)
        prediction = "none" if reason is not None else original
        predictions.append(prediction)
        if reason is not None and prediction != original:
            overrides.append({
                "id": row_id,
                "from": original,
                "to": prediction,
                "reason": reason,
            })
    return predictions, overrides


def metrics_for(labels: list[str], predictions: list[str]) -> dict[str, Any]:
    macro, per_label = macro_f1(labels, predictions)
    return {
        "accuracy": round(accuracy(labels, predictions), 4),
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_false_positive_rate(labels, predictions), 4),
        "prediction_counts": dict(sorted(Counter(predictions).items())),
        "per_label": per_label,
    }


def eval_run(run: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    examples = source_examples(run)
    labels = [str(example["actual"]) for example in examples]
    before_predictions = [str(example["predicted"]) for example in examples]
    after_predictions, overrides = apply_none_safety_gate(examples, fixtures)
    fixed = []
    harmful = []
    for example, after in zip(examples, after_predictions, strict=True):
        before = str(example["predicted"])
        actual = str(example["actual"])
        if actual == "none" and before != "none" and after == "none":
            fixed.append(str(example["id"]))
        if actual != "none" and before == actual and after == "none":
            harmful.append(str(example["id"]))
    return {
        "seed": run.get("seed"),
        "test_rows": len(examples),
        "before": metrics_for(labels, before_predictions),
        "after": metrics_for(labels, after_predictions),
        "override_count": len(overrides),
        "overrides": overrides,
        "override_reasons": dict(sorted(Counter(override["reason"] for override in overrides).items())),
        "fixed_none_false_positive_count": len(fixed),
        "fixed_none_false_positive_ids": sorted(fixed),
        "harmful_override_count": len(harmful),
        "harmful_override_ids": sorted(harmful),
    }


def summarize_runs(runs: list[dict[str, Any]], key: str) -> dict[str, Any]:
    macro_values = [float(run[key]["macro_f1"]) for run in runs]
    accuracy_values = [float(run[key]["accuracy"]) for run in runs]
    none_fp_values = [float(run[key]["none_false_positive_rate"]) for run in runs]
    return {
        "runs": len(runs),
        "macro_f1_mean": round(mean(macro_values), 4),
        "macro_f1_min": round(min(macro_values), 4),
        "macro_f1_max": round(max(macro_values), 4),
        "accuracy_mean": round(mean(accuracy_values), 4),
        "none_false_positive_rate_mean": round(mean(none_fp_values), 4),
        "none_false_positive_rate_max": round(max(none_fp_values), 4),
    }


def decision_for(before: dict[str, Any], after: dict[str, Any], harmful_total: int) -> str:
    if harmful_total > 0:
        return "reject_none_safety_pregate"
    if float(after["none_false_positive_rate_max"]) < 0.10 and float(after["macro_f1_mean"]) >= float(before["macro_f1_mean"]):
        return "candidate_none_safety_pregate"
    return "needs_none_safety_work"


def build_report(robustness_report: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    runs = [eval_run(run, fixtures) for run in list(robustness_report.get("runs") or [])]
    if not runs:
        raise ValueError("robustness report has no runs")
    before = summarize_runs(runs, "before")
    after = summarize_runs(runs, "after")
    override_reasons = Counter()
    for run in runs:
        override_reasons.update(run["override_reasons"])
    harmful_total = sum(int(run["harmful_override_count"]) for run in runs)
    fixed_total = sum(int(run["fixed_none_false_positive_count"]) for run in runs)
    return {
        "schema": "ax.setfit_none_safety_pregate_report.v1",
        "source_schema": robustness_report.get("schema"),
        "source_model": robustness_report.get("model"),
        "source_report": {
            "decision": robustness_report.get("decision"),
            "failures": robustness_report.get("failures"),
            "summary": robustness_report.get("summary"),
            "calibrated_summary": robustness_report.get("calibrated_summary"),
        },
        "gate": {
            "kind": "text_projection_none_safety",
            "uses_actual_label": False,
            "reasons": [
                "context_recall_question",
                "already_executing_continue",
                "completed_workflow_next_question",
                "model_artifact_question",
                "classifier_capacity_question",
            ],
        },
        "summary": {
            "before": before,
            "after": after,
            "override_count_total": sum(int(run["override_count"]) for run in runs),
            "fixed_none_false_positive_count_total": fixed_total,
            "harmful_override_count_total": harmful_total,
            "override_reasons": dict(sorted(override_reasons.items())),
        },
        "runs": runs,
        "decision": decision_for(before, after, harmful_total),
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.robustness), fixture_by_id(args.fixtures))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit none-safety pre-gate report")
        print(f"before none false-positive max: {report['summary']['before']['none_false_positive_rate_max']}")
        print(f"after none false-positive max: {report['summary']['after']['none_false_positive_rate_max']}")
        print(f"fixed none false positives: {report['summary']['fixed_none_false_positive_count_total']}")
        print(f"harmful overrides: {report['summary']['harmful_override_count_total']}")
        print(f"decision: {report['decision']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
