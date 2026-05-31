#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_gate_eval import build_prediction_index, examples_from_rows, unsafe_none_misses  # noqa: E402
from blind_label_review import load_json, write_json  # noqa: E402
from blind_predict import load_jsonl  # noqa: E402
from blind_sensitivity import SCENARIOS, synthetic_rows  # noqa: E402
from eval import macro_f1  # noqa: E402
from robustness import accuracy, none_false_positive_rate  # noqa: E402
from strict_none_gate import apply_strict_none_gate  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate a candidate strict none gate over synthetic blind sensitivity scenarios.")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--suggestions", default=".ax/experiments/blind-session-section-label-suggestions-e51.json")
    parser.add_argument("--priorities", default=".ax/experiments/blind-session-section-review-priority-e52.json")
    parser.add_argument("--predictions", default=".ax/experiments/blind-session-section-predictions-e48.jsonl")
    parser.add_argument("--baseline", default=".ax/experiments/blind-sensitivity-e53.json")
    parser.add_argument("--out", default=".ax/experiments/strict-none-gate-e59.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def eval_scenario(scenario: str, rows: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, Any]:
    predictions_by_id = build_prediction_index(rows, predictions)
    base_examples = examples_from_rows(rows, predictions_by_id)
    labels = [str(example["actual"]) for example in base_examples]
    fixtures = {str(row["id"]): row for row in rows}
    strict_predictions, strict_overrides = apply_strict_none_gate(base_examples, fixtures)
    macro, per_label = macro_f1(labels, strict_predictions)
    final_examples = [
        {**example, "predicted": predicted}
        for example, predicted in zip(base_examples, strict_predictions, strict=True)
    ]
    unsafe = unsafe_none_misses(final_examples)
    return {
        "scenario": scenario,
        "synthetic_label_counts": dict(sorted(Counter(labels).items())),
        "metrics": {
            "accuracy": round(accuracy(labels, strict_predictions), 4),
            "macro_f1": round(macro, 4),
            "none_false_positive_rate": round(none_false_positive_rate(labels, strict_predictions), 4),
            "per_label": per_label,
        },
        "strict_none_overrides": strict_overrides,
        "strict_none_override_count": len(strict_overrides),
        "unsafe_none_miss_count": len(unsafe),
        "unsafe_none_misses": unsafe,
    }


def baseline_unsafe_counts(baseline: dict[str, Any]) -> dict[str, int]:
    return {
        str(scenario.get("scenario")): int(scenario.get("unsafe_none_miss_count") or 0)
        for scenario in baseline.get("scenarios", [])
    }


def build_report(scenario_reports: list[dict[str, Any]], baseline_unsafe: dict[str, int]) -> dict[str, Any]:
    deltas = {
        str(report["scenario"]): int(report["unsafe_none_miss_count"]) - int(baseline_unsafe.get(str(report["scenario"]), 0))
        for report in scenario_reports
    }
    improves_any = any(delta < 0 for delta in deltas.values())
    worsens_any = any(delta > 0 for delta in deltas.values())
    return {
        "schema": "ax.strict_none_gate_eval.v1",
        "blind_eval": False,
        "warning": "Candidate strict none gate over synthetic labels; not a promotion decision.",
        "baseline_unsafe_none_miss_count": baseline_unsafe,
        "unsafe_none_miss_delta": deltas,
        "scenarios": scenario_reports,
        "decision": "candidate_strict_none_gate" if improves_any and not worsens_any else "needs_strict_gate_work",
    }


def run_eval(
    review: dict[str, Any],
    suggestions: dict[str, Any],
    priorities: dict[str, Any],
    predictions: list[dict[str, Any]],
    baseline: dict[str, Any],
) -> dict[str, Any]:
    reports = [
        eval_scenario(scenario, synthetic_rows(review, suggestions, priorities, scenario), predictions)
        for scenario in SCENARIOS
    ]
    return build_report(reports, baseline_unsafe_counts(baseline))


def main() -> int:
    args = parse_args()
    report = run_eval(
        load_json(args.review),
        load_json(args.suggestions),
        load_json(args.priorities),
        load_jsonl(args.predictions),
        load_json(args.baseline),
    )
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("strict none gate eval")
        print(f"decision: {report['decision']}")
        print(f"unsafe none deltas: {report['unsafe_none_miss_delta']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "candidate_strict_none_gate" else 1


if __name__ == "__main__":
    raise SystemExit(main())
