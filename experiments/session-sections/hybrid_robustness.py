#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from none_safety_pregate import (  # noqa: E402
    apply_none_safety_gate,
    fixture_by_id,
    load_json,
    metrics_for,
    source_examples,
    summarize_runs,
)
from robustness import failure_reasons  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate SetFit + deterministic gates as a first-class hybrid robustness report.")
    parser.add_argument("--robustness", default=".ax/experiments/setfit-robustness-workflow-fixtures-current.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-with-workflow-fixture-metadata-current.jsonl")
    parser.add_argument("--out", default=".ax/experiments/hybrid-robustness-workflow-fixtures-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def examples_with_predictions(examples: list[dict[str, Any]], predictions: list[str]) -> list[dict[str, str]]:
    return [
        {
            "id": str(example["id"]),
            "actual": str(example["actual"]),
            "predicted": predicted,
        }
        for example, predicted in zip(examples, predictions, strict=True)
    ]


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
        "override_reasons": dict(sorted(Counter(override["reason"] for override in overrides).items())),
        "overrides": overrides,
        "fixed_none_false_positive_count": len(fixed),
        "fixed_none_false_positive_ids": sorted(fixed),
        "harmful_override_count": len(harmful),
        "harmful_override_ids": sorted(harmful),
        "examples": examples_with_predictions(examples, after_predictions),
    }


def build_report(robustness_report: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    runs = [eval_run(run, fixtures) for run in list(robustness_report.get("runs") or [])]
    if not runs:
        raise ValueError("robustness report has no runs")
    baseline_summary = summarize_runs(runs, "before")
    summary = summarize_runs(runs, "after")
    failures = failure_reasons(summary)
    harmful_total = sum(int(run["harmful_override_count"]) for run in runs)
    override_reasons = Counter()
    for run in runs:
        override_reasons.update(run["override_reasons"])
    if harmful_total > 0:
        decision = "reject_hybrid_robustness"
    else:
        decision = "hybrid_robust_enough" if not failures else "needs_hybrid_quality_work"
    return {
        "schema": "ax.setfit_hybrid_robustness_report.v1",
        "source_schema": robustness_report.get("schema"),
        "source_model": robustness_report.get("model"),
        "source_report": {
            "decision": robustness_report.get("decision"),
            "failures": robustness_report.get("failures"),
            "summary": robustness_report.get("summary"),
            "calibrated_summary": robustness_report.get("calibrated_summary"),
        },
        "policy": {
            "base": "calibrated_setfit_predictions",
            "gates": ["text_projection_none_safety"],
            "uses_actual_label": False,
        },
        "baseline_summary": baseline_summary,
        "summary": summary,
        "override_count_total": sum(int(run["override_count"]) for run in runs),
        "fixed_none_false_positive_count_total": sum(int(run["fixed_none_false_positive_count"]) for run in runs),
        "harmful_override_count_total": harmful_total,
        "override_reasons": dict(sorted(override_reasons.items())),
        "failures": failures,
        "runs": runs,
        "decision": decision,
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
        print("SetFit hybrid robustness report")
        print(f"macro f1 mean/min: {report['summary']['macro_f1_mean']} / {report['summary']['macro_f1_min']}")
        print(f"none false-positive max: {report['summary']['none_false_positive_rate_max']}")
        print(f"harmful overrides: {report['harmful_override_count_total']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "hybrid_robust_enough" else 1


if __name__ == "__main__":
    raise SystemExit(main())
