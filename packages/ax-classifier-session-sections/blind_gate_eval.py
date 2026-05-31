#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_fixture_pack import ALLOWED_LABELS  # noqa: E402
from eval import macro_f1  # noqa: E402
from family_gate import apply_family_gates  # noqa: E402
from pregate_failure_analysis import misses, pair_counts  # noqa: E402
from robustness import accuracy, failure_reasons, none_false_positive_rate  # noqa: E402
from two_stage_pregate import apply_none_gate  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate frozen gate stack against a labeled blind fixture pack and model predictions.")
    parser.add_argument("--fixtures", default=".ax/experiments/blind-session-section-fixtures-e46.jsonl")
    parser.add_argument("--predictions", default=".ax/experiments/blind-session-section-predictions-e47.jsonl")
    parser.add_argument("--out", default=".ax/experiments/blind-gate-stack-eval-e47.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def validate_labeled_rows(rows: list[dict[str, Any]]) -> None:
    pending = [str(row.get("id")) for row in rows if row.get("label") == "__pending__" or row.get("target") == "__pending__"]
    if pending:
        raise ValueError(f"pending labels remain in blind fixture pack: {', '.join(pending[:5])}")
    allowed = set(ALLOWED_LABELS)
    unknown = sorted({str(row.get("label")) for row in rows if str(row.get("label")) not in allowed})
    if unknown:
        raise ValueError(f"unknown labels in blind fixture pack: {', '.join(unknown)}")


def build_prediction_index(rows: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, str]:
    by_id = {str(row.get("id")): str(row.get("predicted")) for row in predictions}
    missing = [str(row.get("id")) for row in rows if str(row.get("id")) not in by_id]
    if missing:
        raise ValueError(f"missing predictions for blind rows: {', '.join(missing[:5])}")
    unknown = sorted({prediction for prediction in by_id.values() if prediction not in set(ALLOWED_LABELS)})
    if unknown:
        raise ValueError(f"unknown predicted labels: {', '.join(unknown)}")
    return by_id


def examples_from_rows(rows: list[dict[str, Any]], predictions_by_id: dict[str, str]) -> list[dict[str, str]]:
    return [
        {
            "id": str(row["id"]),
            "actual": str(row["label"]),
            "predicted": predictions_by_id[str(row["id"])],
        }
        for row in rows
    ]


def unsafe_none_misses(examples: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        example
        for example in examples
        if example["actual"] == "none" and example["predicted"] != "none"
    ]


def build_report(rows: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, Any]:
    validate_labeled_rows(rows)
    predictions_by_id = build_prediction_index(rows, predictions)
    base_examples = examples_from_rows(rows, predictions_by_id)
    labels = [example["actual"] for example in base_examples]
    fixtures = {str(row["id"]): row for row in rows}
    none_predictions, none_overrides = apply_none_gate(base_examples, fixtures)
    none_examples = [
        {**example, "predicted": predicted}
        for example, predicted in zip(base_examples, none_predictions, strict=True)
    ]
    final_predictions, family_overrides = apply_family_gates(none_examples, fixtures)
    final_examples = [
        {**example, "predicted": predicted}
        for example, predicted in zip(base_examples, final_predictions, strict=True)
    ]
    macro, per_label = macro_f1(labels, final_predictions)
    remaining_misses = misses(final_examples)
    unsafe = unsafe_none_misses(final_examples)
    summary = {
        "runs": 1,
        "macro_f1_mean": round(macro, 4),
        "macro_f1_min": round(macro, 4),
        "macro_f1_max": round(macro, 4),
        "accuracy_mean": round(accuracy(labels, final_predictions), 4),
        "none_false_positive_rate_mean": round(none_false_positive_rate(labels, final_predictions), 4),
        "none_false_positive_rate_max": round(none_false_positive_rate(labels, final_predictions), 4),
    }
    failures = failure_reasons(summary)
    if unsafe:
        failures.append("blind set has unsafe none misses")
    return {
        "schema": "ax.blind_gate_stack_eval.v1",
        "fixtures": len(rows),
        "labels": dict(sorted(Counter(labels).items())),
        "metrics": {
            "accuracy": summary["accuracy_mean"],
            "macro_f1": summary["macro_f1_mean"],
            "none_false_positive_rate": summary["none_false_positive_rate_max"],
            "per_label": per_label,
        },
        "none_overrides": none_overrides,
        "none_override_count": len(none_overrides),
        "family_overrides": family_overrides,
        "family_override_count": len(family_overrides),
        "remaining_miss_count": len(remaining_misses),
        "remaining_pair_counts": pair_counts(remaining_misses),
        "unsafe_none_miss_count": len(unsafe),
        "unsafe_none_misses": unsafe,
        "examples": final_examples,
        "failures": failures,
        "decision": "candidate_blind_gate_stack" if not failures else "needs_gate_stack_work",
    }


def preflight_error_report(error: ValueError, fixtures_path: str, predictions_path: str) -> dict[str, Any]:
    return {
        "schema": "ax.blind_gate_stack_eval_preflight.v1",
        "fixtures": fixtures_path,
        "predictions": predictions_path,
        "failures": [str(error)],
        "decision": "needs_labeled_blind_fixtures",
    }


def main() -> int:
    args = parse_args()
    try:
        report = build_report(load_jsonl(args.fixtures), load_jsonl(args.predictions))
    except ValueError as error:
        report = preflight_error_report(error, args.fixtures, args.predictions)
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2) + "\n")
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print("blind gate stack eval preflight")
            print(f"decision: {report['decision']}")
            print(f"failures: {report['failures']}")
            print(f"out: {out}")
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind gate stack eval")
        print(f"fixtures: {report['fixtures']}")
        print(f"macro f1: {report['metrics']['macro_f1']}")
        print(f"none false-positive rate: {report['metrics']['none_false_positive_rate']}")
        print(f"unsafe none misses: {report['unsafe_none_miss_count']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "candidate_blind_gate_stack" else 1


if __name__ == "__main__":
    raise SystemExit(main())
