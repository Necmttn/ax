#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import load_rows, macro_f1  # noqa: E402
from robustness import accuracy, failure_reasons, none_false_positive_rate  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate deterministic none pre-gates over a saved two-stage SetFit report.")
    parser.add_argument("--report", default=".ax/experiments/setfit-two-stage-e39-pair-group-seed7.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl")
    parser.add_argument("--out", default=".ax/experiments/setfit-two-stage-pregate-e41.json")
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


def none_gate_reason(row: dict[str, Any]) -> str | None:
    text = text_for(row)
    if contains_any(text, ("how large", "how big", "where would contributors download", "model cache")) and contains_any(text, ("model", "artifact", "download", "package")):
        return "model_artifact_question"
    if contains_any(text, ("how big is the text", "how large is the text", "how much text")) and contains_any(text, ("classify", "classifier", "classification")):
        return "classifier_capacity_question"
    if contains_any(text, ("what was the task i gave you", "what task did i give you", "what did i ask you to do")):
        return "context_recall_question"
    if contains_any(text, ("commit any uncommitted work", "is there any dirty files left", "are there any dirty files left")) and not contains_any(text, ("status is wrong", "said classifier work was committed", "said the classifier work was committed")):
        return "git_hygiene_question"
    if contains_any(text, ("what is next", "whats next", "what's next")) and contains_any(text, ("completed", "results", "verification", "summary")):
        return "completed_workflow_next_question"
    if contains_any(text, ("user:\ncontinue", "user:\ngo")) and contains_any(text, ("already executing", "already executing the agreed plan")):
        return "already_executing_continue"
    return None


def apply_none_gate(
    examples: list[dict[str, Any]],
    fixtures: dict[str, dict[str, Any]],
) -> tuple[list[str], list[dict[str, str]]]:
    predictions = []
    overrides = []
    for example in examples:
        row_id = str(example["id"])
        fixture = fixtures.get(row_id)
        if fixture is None:
            raise ValueError(f"missing fixture for report example: {row_id}")
        reason = none_gate_reason(fixture)
        if reason is not None:
            predictions.append("none")
            overrides.append({"id": row_id, "reason": reason})
        else:
            predictions.append(str(example["predicted"]))
    return predictions, overrides


def build_report(two_stage_report: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if len(two_stage_report.get("runs") or []) != 1:
        raise ValueError("pre-gate eval currently expects a single run report")
    run = two_stage_report["runs"][0]
    examples = list(run["examples"])
    labels = [str(example["actual"]) for example in examples]
    predictions, overrides = apply_none_gate(examples, fixtures)
    macro, per_label = macro_f1(labels, predictions)
    metrics = {
        "accuracy": round(accuracy(labels, predictions), 4),
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_false_positive_rate(labels, predictions), 4),
        "prediction_counts": dict(sorted(Counter(predictions).items())),
        "per_label": per_label,
    }
    failures = failure_reasons({
        "macro_f1_mean": metrics["macro_f1"],
        "macro_f1_min": metrics["macro_f1"],
        "none_false_positive_rate_max": metrics["none_false_positive_rate"],
    })
    override_actuals = Counter(str(next(example["actual"] for example in examples if str(example["id"]) == override["id"])) for override in overrides)
    return {
        "schema": "ax.setfit_two_stage_pregate_report.v1",
        "source_schema": two_stage_report.get("schema"),
        "source_model": two_stage_report.get("model"),
        "source_report": two_stage_report.get("summary"),
        "seed": run.get("seed"),
        "metrics": metrics,
        "overrides": overrides,
        "override_count": len(overrides),
        "override_actuals": dict(sorted(override_actuals.items())),
        "failures": failures,
        "decision": "adopt_none_pregate" if not failures else "reject_none_pregate",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.report), fixture_by_id(args.fixtures))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit two-stage none pre-gate report")
        print(f"macro f1: {report['metrics']['macro_f1']}")
        print(f"accuracy: {report['metrics']['accuracy']}")
        print(f"none false-positive rate: {report['metrics']['none_false_positive_rate']}")
        print(f"overrides: {report['override_count']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "adopt_none_pregate" else 1


if __name__ == "__main__":
    raise SystemExit(main())
