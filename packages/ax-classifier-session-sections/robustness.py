#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "datasets>=2.20",
#   "scikit-learn>=1.5",
#   "sentence-transformers>=3.0,<6",
#   "setfit>=1.1,<2",
#   "transformers>=4.41,<4.57",
# ]
# ///
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path
from statistics import mean
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import (  # noqa: E402
    apply_label_mode,
    confusion_counts,
    dataset_from_rows,
    grouped_stratified_split,
    load_rows,
    macro_f1,
    read_test_ids,
    split_by_test_ids,
    stratified_split,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run repeated SetFit train/test splits for robustness checks.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--out", default=".ax/experiments/setfit-robustness-e15.json")
    parser.add_argument("--seeds", default="7,13,42")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--label-mode", choices=["fine", "coarse"], default="coarse")
    parser.add_argument("--calibration-threshold", type=float, default=None)
    parser.add_argument("--test-ids", default=None, help="Optional JSON or line-delimited file of fixed held-out fixture ids.")
    parser.add_argument("--group-field", default=None, help="Hold out whole groups by this row field when --test-ids is not set.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def parse_seeds(value: str) -> list[int]:
    seeds = [int(part.strip()) for part in value.split(",") if part.strip()]
    if not seeds:
        raise ValueError("--seeds must include at least one integer")
    return seeds


def none_false_positive_rate(labels: list[str], predictions: list[str]) -> float:
    none_total = sum(1 for actual in labels if actual == "none")
    none_fp = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == "none" and predicted != "none")
    return none_fp / none_total if none_total else 0.0


def accuracy(labels: list[str], predictions: list[str]) -> float:
    if not labels:
        return 0.0
    correct = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == predicted)
    return correct / len(labels)


def split_rows(
    rows: list[dict[str, Any]],
    seed: int,
    test_ids: set[str] | None = None,
    group_field: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if test_ids:
        return split_by_test_ids(rows, test_ids)
    if group_field:
        return grouped_stratified_split(rows, seed, group_field)
    return stratified_split(rows, seed)


def tensor_rows(value: Any) -> list[list[float]]:
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return [[float(item) for item in row] for row in value.tolist()]


def best_label(proba: list[float], labels: list[str]) -> tuple[str, float]:
    best_index = max(range(len(proba)), key=lambda index: proba[index])
    return labels[best_index], proba[best_index]


def calibrated_label(label: str, confidence: float, threshold: float | None) -> str:
    if threshold is None:
        return label
    if label == "none":
        return "none"
    if confidence < threshold:
        return "none"
    return label


def metrics_for_predictions(
    rows: list[dict[str, Any]],
    labels: list[str],
    predictions: list[str],
    train_seconds: float,
    predict_seconds: float,
) -> dict[str, Any]:
    macro, per_label = macro_f1(labels, predictions)
    return {
        "test_labels": dict(sorted(Counter(labels).items())),
        "accuracy": round(accuracy(labels, predictions), 4),
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_false_positive_rate(labels, predictions), 4),
        "per_label": per_label,
        "confusion": confusion_counts(labels, predictions),
        "train_seconds": round(train_seconds, 2),
        "predict_seconds": round(predict_seconds, 2),
        "examples": [
            {
                "id": row.get("id"),
                "actual": actual,
                "predicted": predicted,
            }
            for row, actual, predicted in zip(rows, labels, predictions, strict=True)
        ],
    }


def eval_seed(
    rows: list[dict[str, Any]],
    seed: int,
    model_name: str,
    epochs: int,
    batch_size: int,
    test_ids: set[str] | None = None,
    group_field: str | None = None,
    calibration_threshold: float | None = None,
) -> dict[str, Any]:
    from setfit import SetFitModel, Trainer, TrainingArguments

    label_names = sorted({str(row["label"]) for row in rows})
    label_to_id = {label: index for index, label in enumerate(label_names)}
    train_rows, test_rows = split_rows(rows, seed, test_ids, group_field)
    train_dataset = dataset_from_rows(train_rows, label_to_id)

    started = time.perf_counter()
    model = SetFitModel.from_pretrained(model_name, labels=label_names)
    trainer = Trainer(
        model=model,
        args=TrainingArguments(batch_size=batch_size, num_epochs=epochs),
        train_dataset=train_dataset,
    )
    trainer.train()
    train_seconds = time.perf_counter() - started

    predict_started = time.perf_counter()
    test_texts = [str(row["text"]) for row in test_rows]
    probas = tensor_rows(model.predict_proba(test_texts))
    raw_predictions_with_confidence = [
        best_label(proba, label_names)
        for proba in probas
    ]
    predict_seconds = time.perf_counter() - predict_started
    labels = [str(row["label"]) for row in test_rows]
    raw_predictions = [label for label, _confidence in raw_predictions_with_confidence]
    calibrated_predictions = [
        calibrated_label(label, confidence, calibration_threshold)
        for label, confidence in raw_predictions_with_confidence
    ]
    raw = metrics_for_predictions(test_rows, labels, raw_predictions, train_seconds, predict_seconds)
    result = {
        "seed": seed,
        "train_rows": len(train_rows),
        "test_rows": len(test_rows),
        **raw,
        "raw_predictions_with_confidence": [
            {
                "id": row.get("id"),
                "actual": actual,
                "predicted": label,
                "confidence": round(confidence, 4),
            }
            for row, actual, (label, confidence) in zip(test_rows, labels, raw_predictions_with_confidence, strict=True)
        ],
    }
    if calibration_threshold is not None:
        calibrated = metrics_for_predictions(test_rows, labels, calibrated_predictions, train_seconds, predict_seconds)
        result["calibrated"] = {
            "threshold": calibration_threshold,
            **calibrated,
        }
    return result


def summarize_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    macro_values = [float(run["macro_f1"]) for run in runs]
    none_fp_values = [float(run["none_false_positive_rate"]) for run in runs]
    accuracy_values = [float(run["accuracy"]) for run in runs]
    train_seconds = [float(run["train_seconds"]) for run in runs]
    return {
        "runs": len(runs),
        "macro_f1_mean": round(mean(macro_values), 4),
        "macro_f1_min": round(min(macro_values), 4),
        "macro_f1_max": round(max(macro_values), 4),
        "accuracy_mean": round(mean(accuracy_values), 4),
        "none_false_positive_rate_mean": round(mean(none_fp_values), 4),
        "none_false_positive_rate_max": round(max(none_fp_values), 4),
        "train_seconds_total": round(sum(train_seconds), 2),
    }


def calibrated_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [run["calibrated"] for run in runs if "calibrated" in run]


def failure_reasons(summary: dict[str, Any]) -> list[str]:
    failures = []
    if float(summary["macro_f1_mean"]) < 0.75:
        failures.append("mean macro F1 is below 0.75")
    if float(summary["macro_f1_min"]) < 0.70:
        failures.append("minimum macro F1 is below 0.70")
    if float(summary["none_false_positive_rate_max"]) >= 0.10:
        failures.append("worst none false-positive rate is not below 10%")
    return failures


def main() -> int:
    args = parse_args()
    seeds = parse_seeds(args.seeds)
    rows = apply_label_mode(load_rows(args.fixtures), args.label_mode)
    test_ids = read_test_ids(args.test_ids) if args.test_ids else None
    runs = [
        eval_seed(
            rows,
            seed,
            args.model,
            args.epochs,
            args.batch_size,
            test_ids=test_ids,
            group_field=args.group_field,
            calibration_threshold=args.calibration_threshold,
        )
        for seed in seeds
    ]
    summary = summarize_runs(runs)
    calibrated = calibrated_runs(runs)
    calibrated_summary = summarize_runs(calibrated) if calibrated else None
    gate_summary = calibrated_summary or summary
    failures = failure_reasons(gate_summary)
    report = {
        "schema": "ax.setfit_robustness_report.v1",
        "model": args.model,
        "label_mode": args.label_mode,
        "fixtures": len(rows),
        "labels": dict(sorted(Counter(str(row["label"]) for row in rows).items())),
        "seeds": seeds,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "test_ids": args.test_ids,
        "group_field": args.group_field,
        "calibration_threshold": args.calibration_threshold,
        "summary": summary,
        "calibrated_summary": calibrated_summary,
        "runs": runs,
        "failures": failures,
        "decision": "robust_enough" if not failures else "needs_model_quality_work",
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit robustness report")
        print(f"fixtures: {report['fixtures']}")
        print(f"label mode: {report['label_mode']}")
        print(f"seeds: {report['seeds']}")
        print(f"macro f1 mean/min/max: {summary['macro_f1_mean']} / {summary['macro_f1_min']} / {summary['macro_f1_max']}")
        print(f"none false-positive mean/max: {summary['none_false_positive_rate_mean']} / {summary['none_false_positive_rate_max']}")
        if calibrated_summary:
            print(f"calibration threshold: {args.calibration_threshold}")
            print(f"calibrated macro f1 mean/min/max: {calibrated_summary['macro_f1_mean']} / {calibrated_summary['macro_f1_min']} / {calibrated_summary['macro_f1_max']}")
            print(f"calibrated none false-positive mean/max: {calibrated_summary['none_false_positive_rate_mean']} / {calibrated_summary['none_false_positive_rate_max']}")
        print(f"train seconds total: {summary['train_seconds_total']}")
        print(f"decision: {report['decision']}")
        print(f"failures: {failures}")
        print(f"out: {out}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
