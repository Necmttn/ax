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
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import (  # noqa: E402
    apply_label_mode,
    dataset_from_rows,
    grouped_stratified_split,
    load_rows,
    read_test_ids,
    split_by_test_ids,
    stratified_split,
)
from robustness import (  # noqa: E402
    best_label,
    failure_reasons,
    metrics_for_predictions,
    summarize_runs,
    tensor_rows,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run two-stage SetFit session-section eval: none/actionable, then actionable family.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--out", default=".ax/experiments/setfit-two-stage-e39.json")
    parser.add_argument("--seeds", default="7")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--label-mode", choices=["fine", "coarse"], default="coarse")
    parser.add_argument("--test-ids", default=None, help="Optional JSON or line-delimited file of fixed held-out fixture ids.")
    parser.add_argument("--group-field", default=None, help="Hold out whole groups by this row field when --test-ids is not set.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def parse_seeds(value: str) -> list[int]:
    seeds = [int(part.strip()) for part in value.split(",") if part.strip()]
    if not seeds:
        raise ValueError("--seeds must include at least one integer")
    return seeds


def binary_label(label: str) -> str:
    return "none" if label == "none" else "actionable"


def binary_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            **row,
            "family_label": str(row["label"]),
            "label": binary_label(str(row["label"])),
        }
        for row in rows
    ]


def actionable_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if str(row["label"]) != "none"]


def final_predictions(binary_predictions: list[str], family_predictions: list[str]) -> list[str]:
    family_index = 0
    final: list[str] = []
    for prediction in binary_predictions:
        if prediction == "none":
            final.append("none")
            continue
        if family_index >= len(family_predictions):
            raise ValueError("not enough family predictions for actionable binary predictions")
        final.append(family_predictions[family_index])
        family_index += 1
    if family_index != len(family_predictions):
        raise ValueError("unused family predictions")
    return final


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


def train_predict(
    train_rows: list[dict[str, Any]],
    test_rows: list[dict[str, Any]],
    model_name: str,
    epochs: int,
    batch_size: int,
) -> tuple[list[str], list[dict[str, Any]], float, float]:
    from setfit import SetFitModel, Trainer, TrainingArguments

    label_names = sorted({str(row["label"]) for row in train_rows})
    if len(label_names) < 2:
        raise ValueError(f"SetFit stage needs at least two labels, got: {label_names}")
    label_to_id = {label: index for index, label in enumerate(label_names)}
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
    probas = tensor_rows(model.predict_proba([str(row["text"]) for row in test_rows]))
    predictions_with_confidence = [
        best_label(proba, label_names)
        for proba in probas
    ]
    predict_seconds = time.perf_counter() - predict_started
    predictions = [label for label, _confidence in predictions_with_confidence]
    prediction_details = [
        {
            "id": row.get("id"),
            "actual": row.get("label"),
            "predicted": label,
            "confidence": round(confidence, 4),
        }
        for row, (label, confidence) in zip(test_rows, predictions_with_confidence, strict=True)
    ]
    return predictions, prediction_details, train_seconds, predict_seconds


def eval_seed(
    rows: list[dict[str, Any]],
    seed: int,
    model_name: str,
    epochs: int,
    batch_size: int,
    test_ids: set[str] | None = None,
    group_field: str | None = None,
) -> dict[str, Any]:
    train_rows, test_rows = split_rows(rows, seed, test_ids, group_field)
    binary_train_rows = binary_rows(train_rows)
    binary_test_rows = binary_rows(test_rows)

    binary_predictions, binary_details, binary_train_seconds, binary_predict_seconds = train_predict(
        binary_train_rows,
        binary_test_rows,
        model_name,
        epochs,
        batch_size,
    )
    binary_labels = [str(row["label"]) for row in binary_test_rows]
    binary_metrics = metrics_for_predictions(
        binary_test_rows,
        binary_labels,
        binary_predictions,
        binary_train_seconds,
        binary_predict_seconds,
    )

    family_train_rows = actionable_rows(train_rows)
    family_test_rows = [
        row
        for row, prediction in zip(test_rows, binary_predictions, strict=True)
        if prediction == "actionable"
    ]
    family_predictions, family_details, family_train_seconds, family_predict_seconds = train_predict(
        family_train_rows,
        family_test_rows,
        model_name,
        epochs,
        batch_size,
    ) if family_test_rows else ([], [], 0.0, 0.0)
    final = final_predictions(binary_predictions, family_predictions)
    final_labels = [str(row["label"]) for row in test_rows]
    final_metrics = metrics_for_predictions(
        test_rows,
        final_labels,
        final,
        binary_train_seconds + family_train_seconds,
        binary_predict_seconds + family_predict_seconds,
    )

    return {
        "seed": seed,
        "train_rows": len(train_rows),
        "test_rows": len(test_rows),
        "family_train_rows": len(family_train_rows),
        "family_test_rows": len(family_test_rows),
        **final_metrics,
        "binary": {
            **binary_metrics,
            "predictions_with_confidence": binary_details,
        },
        "family": {
            "test_labels": dict(sorted(Counter(str(row["label"]) for row in family_test_rows).items())),
            "predictions_with_confidence": family_details,
        },
    }


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
        )
        for seed in seeds
    ]
    summary = summarize_runs(runs)
    failures = failure_reasons(summary)
    report = {
        "schema": "ax.setfit_two_stage_report.v1",
        "model": args.model,
        "label_mode": args.label_mode,
        "fixtures": len(rows),
        "labels": dict(sorted(Counter(str(row["label"]) for row in rows).items())),
        "seeds": seeds,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "test_ids": args.test_ids,
        "group_field": args.group_field,
        "summary": summary,
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
        print("SetFit two-stage report")
        print(f"fixtures: {report['fixtures']}")
        print(f"label mode: {report['label_mode']}")
        print(f"seeds: {report['seeds']}")
        print(f"macro f1 mean/min/max: {summary['macro_f1_mean']} / {summary['macro_f1_min']} / {summary['macro_f1_max']}")
        print(f"none false-positive mean/max: {summary['none_false_positive_rate_mean']} / {summary['none_false_positive_rate_max']}")
        print(f"train seconds total: {summary['train_seconds_total']}")
        print(f"decision: {report['decision']}")
        if failures:
            print(f"failures: {failures}")
        print(f"out: {out}")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
