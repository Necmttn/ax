#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from statistics import mean
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import macro_f1  # noqa: E402
from family_gate import apply_family_gates  # noqa: E402
from pregate_failure_analysis import load_fixture_index, load_json, misses, pair_counts  # noqa: E402
from robustness import accuracy, failure_reasons, none_false_positive_rate  # noqa: E402
from two_stage_pregate import apply_none_gate  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate frozen none + family gate stack over every run in a two-stage SetFit report.")
    parser.add_argument("--two-stage", default=".ax/experiments/setfit-two-stage-e44-pair-group-repeated.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl")
    parser.add_argument("--out", default=".ax/experiments/setfit-gate-stack-robustness-e44.json")
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
    examples = list(run["examples"])
    labels = [str(example["actual"]) for example in examples]
    none_predictions, none_overrides = apply_none_gate(examples, fixtures)
    none_gated_examples = examples_with_predictions(examples, none_predictions)
    family_predictions, family_overrides = apply_family_gates(none_gated_examples, fixtures)
    macro, per_label = macro_f1(labels, family_predictions)
    final_examples = examples_with_predictions(examples, family_predictions)
    remaining_misses = misses(final_examples)
    return {
        "seed": run.get("seed"),
        "test_rows": len(examples),
        "accuracy": round(accuracy(labels, family_predictions), 4),
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_false_positive_rate(labels, family_predictions), 4),
        "per_label": per_label,
        "none_overrides": none_overrides,
        "none_override_count": len(none_overrides),
        "family_overrides": family_overrides,
        "family_override_count": len(family_overrides),
        "remaining_miss_count": len(remaining_misses),
        "remaining_pair_counts": pair_counts(remaining_misses),
        "examples": final_examples,
    }


def summarize_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    macro_values = [float(run["macro_f1"]) for run in runs]
    accuracy_values = [float(run["accuracy"]) for run in runs]
    none_fp_values = [float(run["none_false_positive_rate"]) for run in runs]
    miss_counts = [int(run["remaining_miss_count"]) for run in runs]
    return {
        "runs": len(runs),
        "macro_f1_mean": round(mean(macro_values), 4),
        "macro_f1_min": round(min(macro_values), 4),
        "macro_f1_max": round(max(macro_values), 4),
        "accuracy_mean": round(mean(accuracy_values), 4),
        "none_false_positive_rate_mean": round(mean(none_fp_values), 4),
        "none_false_positive_rate_max": round(max(none_fp_values), 4),
        "remaining_miss_count_total": sum(miss_counts),
        "remaining_miss_count_max": max(miss_counts),
    }


def build_report(two_stage_report: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    runs = [eval_run(run, fixtures) for run in list(two_stage_report.get("runs") or [])]
    if not runs:
        raise ValueError("two-stage report has no runs")
    summary = summarize_runs(runs)
    failures = failure_reasons(summary)
    return {
        "schema": "ax.setfit_gate_stack_robustness_report.v1",
        "source_schema": two_stage_report.get("schema"),
        "source_model": two_stage_report.get("model"),
        "source_report": two_stage_report.get("summary"),
        "summary": summary,
        "runs": runs,
        "failures": failures,
        "decision": "candidate_robust_gate_stack" if not failures else "needs_gate_stack_work",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.two_stage), load_fixture_index(args.fixtures))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit gate stack robustness report")
        print(f"runs: {report['summary']['runs']}")
        print(f"macro f1 mean/min: {report['summary']['macro_f1_mean']} / {report['summary']['macro_f1_min']}")
        print(f"none false-positive max: {report['summary']['none_false_positive_rate_max']}")
        print(f"remaining misses total: {report['summary']['remaining_miss_count_total']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "candidate_robust_gate_stack" else 1


if __name__ == "__main__":
    raise SystemExit(main())
