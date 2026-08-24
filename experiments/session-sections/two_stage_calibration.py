#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import macro_f1  # noqa: E402
from robustness import accuracy, failure_reasons, none_false_positive_rate  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sweep binary-stage confidence thresholds for a saved two-stage SetFit report.")
    parser.add_argument("--report", default=".ax/experiments/setfit-two-stage-e39-pair-group-seed7.json")
    parser.add_argument("--out", default=".ax/experiments/setfit-two-stage-calibration-e40.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def calibrated_binary_predictions(predictions: list[dict[str, Any]], threshold: float) -> list[str]:
    calibrated = []
    for prediction in predictions:
        label = str(prediction["predicted"])
        confidence = float(prediction["confidence"])
        if label == "actionable" and confidence < threshold:
            calibrated.append("none")
        else:
            calibrated.append(label)
    return calibrated


def final_predictions_after_binary_calibration(
    final_examples: list[dict[str, Any]],
    binary_predictions: list[str],
) -> list[str]:
    if len(final_examples) != len(binary_predictions):
        raise ValueError("final examples and binary predictions must have equal length")
    final = []
    for example, binary_prediction in zip(final_examples, binary_predictions, strict=True):
        if binary_prediction == "none":
            final.append("none")
        else:
            final.append(str(example["predicted"]))
    return final


def threshold_metrics(run: dict[str, Any], threshold: float) -> dict[str, Any]:
    examples = list(run["examples"])
    labels = [str(example["actual"]) for example in examples]
    binary_predictions = calibrated_binary_predictions(
        list(run["binary"]["predictions_with_confidence"]),
        threshold,
    )
    predictions = final_predictions_after_binary_calibration(examples, binary_predictions)
    macro, per_label = macro_f1(labels, predictions)
    return {
        "threshold": round(threshold, 4),
        "accuracy": round(accuracy(labels, predictions), 4),
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_false_positive_rate(labels, predictions), 4),
        "prediction_counts": dict(sorted(Counter(predictions).items())),
        "per_label": per_label,
        "binary_prediction_counts": dict(sorted(Counter(binary_predictions).items())),
    }


def sweep_thresholds(run: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        threshold_metrics(run, threshold / 100)
        for threshold in range(0, 101, 5)
    ]


def build_report(two_stage_report: dict[str, Any]) -> dict[str, Any]:
    if len(two_stage_report.get("runs") or []) != 1:
        raise ValueError("two-stage calibration currently expects a single run report")
    run = two_stage_report["runs"][0]
    thresholds = sweep_thresholds(run)
    best_macro = max(thresholds, key=lambda row: (row["macro_f1"], -row["none_false_positive_rate"], row["accuracy"]))
    none_safe = [row for row in thresholds if row["none_false_positive_rate"] < 0.10]
    best_none_safe = max(none_safe, key=lambda row: (row["macro_f1"], row["accuracy"])) if none_safe else None
    gate = best_none_safe or best_macro
    failures = failure_reasons({
        "macro_f1_mean": gate["macro_f1"],
        "macro_f1_min": gate["macro_f1"],
        "none_false_positive_rate_max": gate["none_false_positive_rate"],
    })
    return {
        "schema": "ax.setfit_two_stage_calibration_report.v1",
        "source_schema": two_stage_report.get("schema"),
        "source_model": two_stage_report.get("model"),
        "source_report": two_stage_report.get("summary"),
        "seed": run.get("seed"),
        "thresholds": thresholds,
        "base": threshold_metrics(run, 0.0),
        "best_macro": best_macro,
        "best_none_safe": best_none_safe,
        "failures": failures,
        "decision": "adopt_binary_threshold" if best_none_safe and not failures else "reject_binary_threshold_only",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.report))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit two-stage calibration report")
        print(f"base macro f1: {report['base']['macro_f1']}")
        print(f"base none false-positive rate: {report['base']['none_false_positive_rate']}")
        print(f"best macro threshold: {report['best_macro']['threshold']}")
        print(f"best macro f1: {report['best_macro']['macro_f1']}")
        print(f"best macro none false-positive rate: {report['best_macro']['none_false_positive_rate']}")
        if report["best_none_safe"]:
            print(f"best none-safe threshold: {report['best_none_safe']['threshold']}")
            print(f"best none-safe macro f1: {report['best_none_safe']['macro_f1']}")
        else:
            print("best none-safe threshold: none")
        print(f"decision: {report['decision']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "adopt_binary_threshold" else 1


if __name__ == "__main__":
    raise SystemExit(main())
