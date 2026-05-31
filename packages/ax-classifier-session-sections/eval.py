#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "datasets>=2.20",
#   "numpy>=1.26",
#   "scikit-learn>=1.5",
#   "sentence-transformers>=3.0,<6",
#   "setfit>=1.1,<2",
#   "transformers>=4.41,<4.57",
# ]
# ///
from __future__ import annotations

import argparse
import json
import random
import shutil
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train/evaluate the AX session-section SetFit chunk classifier.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--model-dir", default=".ax/experiments/setfit-session-sections-model")
    parser.add_argument("--out", default=".ax/experiments/setfit-session-sections-e3.json")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--label-mode", choices=["fine", "coarse"], default="fine")
    parser.add_argument("--test-ids", default=None, help="Optional JSON or line-delimited file of fixed held-out fixture ids.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_rows(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(Path(path).read_text().splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not str(row.get("text") or "").strip():
            raise ValueError(f"{path}:{line_number} missing text")
        if not str(row.get("label") or "").strip():
            raise ValueError(f"{path}:{line_number} missing label")
        rows.append(row)
    return rows


def read_test_ids(path: str) -> set[str]:
    content = Path(path).read_text().strip()
    if not content:
        return set()
    if content.startswith("{") or content.startswith("["):
        parsed = json.loads(content)
        values = parsed.get("test_ids") if isinstance(parsed, dict) else parsed
        if not isinstance(values, list):
            raise ValueError(f"{path} must contain a list or object with test_ids")
        return {str(value) for value in values}
    return {line.strip() for line in content.splitlines() if line.strip()}


def map_label(label: str, mode: str) -> str:
    if mode == "fine":
        return label
    if mode != "coarse":
        raise ValueError(f"unknown label mode: {mode}")
    if label in {"direction", "tooling_or_environment_issue"}:
        return "environment_or_preference_signal"
    if label in {"correction", "rejection"}:
        return "correction_or_rejection_signal"
    if label in {"verification_request", "recovery_action"}:
        return "verification_or_recovery_signal"
    if label == "approval":
        return "approval"
    if label == "none":
        return "none"
    return label


def apply_label_mode(rows: list[dict[str, Any]], mode: str) -> list[dict[str, Any]]:
    return [
        {
            **row,
            "original_label": str(row["label"]),
            "label": map_label(str(row["label"]), mode),
        }
        for row in rows
    ]


def stratified_split(rows: list[dict[str, Any]], seed: int, test_fraction: float = 0.25) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rng = random.Random(seed)
    by_label: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_label[str(row["label"])].append(row)

    train: list[dict[str, Any]] = []
    test: list[dict[str, Any]] = []
    for label, label_rows in sorted(by_label.items()):
        shuffled = label_rows[:]
        rng.shuffle(shuffled)
        test_count = max(1, round(len(shuffled) * test_fraction))
        if len(shuffled) - test_count < 1:
            test_count = len(shuffled) - 1
        test.extend(shuffled[:test_count])
        train.extend(shuffled[test_count:])
    rng.shuffle(train)
    rng.shuffle(test)
    return train, test


def split_by_test_ids(rows: list[dict[str, Any]], test_ids: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    row_ids = {str(row.get("id")) for row in rows}
    unknown = sorted(test_ids - row_ids)
    if unknown:
        raise ValueError(f"unknown fixed test ids: {', '.join(unknown)}")
    train = [row for row in rows if str(row.get("id")) not in test_ids]
    test = [row for row in rows if str(row.get("id")) in test_ids]
    if not train:
        raise ValueError("fixed test ids leave no training rows")
    if not test:
        raise ValueError("fixed test ids select no test rows")
    return train, test


def group_value(row: dict[str, Any], group_field: str) -> str:
    value = row.get(group_field)
    if value is None or str(value).strip() == "":
        row_id = row.get("id", "<unknown>")
        raise ValueError(f"missing group field {group_field!r} on row {row_id}")
    return str(value)


def grouped_stratified_split(
    rows: list[dict[str, Any]],
    seed: int,
    group_field: str,
    test_fraction: float = 0.25,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rng = random.Random(seed)
    by_group: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_group[group_value(row, group_field)].append(row)

    total_by_label = Counter(str(row["label"]) for row in rows)
    desired_by_label = {
        label: max(1, round(total * test_fraction))
        for label, total in total_by_label.items()
    }
    group_items = list(by_group.items())
    rng.shuffle(group_items)
    group_items.sort(key=lambda item: len(item[1]), reverse=True)

    test_groups: set[str] = set()
    test_by_label: Counter[str] = Counter()
    for group, group_rows in group_items:
        group_counts = Counter(str(row["label"]) for row in group_rows)
        helps_underfilled_label = any(
            test_by_label[label] < desired_by_label[label]
            for label in group_counts
        )
        leaves_training_examples = all(
            test_by_label[label] + count < total_by_label[label]
            for label, count in group_counts.items()
        )
        if helps_underfilled_label and leaves_training_examples:
            test_groups.add(group)
            test_by_label.update(group_counts)

    train = [row for row in rows if group_value(row, group_field) not in test_groups]
    test = [row for row in rows if group_value(row, group_field) in test_groups]
    train_labels = {str(row["label"]) for row in train}
    test_labels = {str(row["label"]) for row in test}
    missing_train = sorted(set(total_by_label) - train_labels)
    missing_test = sorted(set(total_by_label) - test_labels)
    if missing_train:
        raise ValueError(f"grouped split leaves labels without training rows: {', '.join(missing_train)}")
    if missing_test:
        raise ValueError(f"grouped split leaves labels without test rows: {', '.join(missing_test)}")
    rng.shuffle(train)
    rng.shuffle(test)
    return train, test


def dataset_from_rows(rows: list[dict[str, Any]], label_to_id: dict[str, int]) -> Dataset:
    from datasets import Dataset

    return Dataset.from_list([
        {
            "text": str(row["text"]),
            "label": label_to_id[str(row["label"])],
        }
        for row in rows
    ])


def macro_f1(labels: list[str], predictions: list[str]) -> tuple[float, dict[str, dict[str, float]]]:
    classes = sorted(set(labels) | set(predictions))
    per_label: dict[str, dict[str, float]] = {}
    f1s: list[float] = []
    for cls in classes:
        tp = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == cls and predicted == cls)
        fp = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual != cls and predicted == cls)
        fn = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == cls and predicted != cls)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        f1s.append(f1)
        per_label[cls] = {
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "support": sum(1 for actual in labels if actual == cls),
        }
    return (sum(f1s) / len(f1s) if f1s else 0.0), per_label


def confusion_counts(labels: list[str], predictions: list[str]) -> dict[str, dict[str, int]]:
    matrix: dict[str, dict[str, int]] = {}
    for actual, predicted in zip(labels, predictions, strict=True):
        matrix.setdefault(actual, {})
        matrix[actual][predicted] = matrix[actual].get(predicted, 0) + 1
    return matrix


def directory_size(path: Path) -> int:
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def label_predictions(raw_predictions: Any, label_names: list[str]) -> list[str]:
    predictions: list[str] = []
    for value in list(raw_predictions):
        if isinstance(value, str):
            predictions.append(value)
        else:
            predictions.append(label_names[int(value)])
    return predictions


def main() -> int:
    from setfit import SetFitModel, Trainer, TrainingArguments

    args = parse_args()
    rows = apply_label_mode(load_rows(args.fixtures), args.label_mode)
    label_names = sorted({str(row["label"]) for row in rows})
    label_to_id = {label: index for index, label in enumerate(label_names)}
    test_ids = read_test_ids(args.test_ids) if args.test_ids else None
    train_rows, test_rows = split_by_test_ids(rows, test_ids) if test_ids else stratified_split(rows, args.seed)
    train_dataset = dataset_from_rows(train_rows, label_to_id)

    started = time.perf_counter()
    model = SetFitModel.from_pretrained(args.model, labels=label_names)
    train_args = TrainingArguments(
        batch_size=args.batch_size,
        num_epochs=args.epochs,
    )
    trainer = Trainer(
        model=model,
        args=train_args,
        train_dataset=train_dataset,
    )
    trainer.train()
    train_seconds = time.perf_counter() - started

    predict_started = time.perf_counter()
    predictions = label_predictions(model.predict([str(row["text"]) for row in test_rows]), label_names)
    predict_seconds = time.perf_counter() - predict_started
    labels = [str(row["label"]) for row in test_rows]
    correct = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == predicted)
    macro, per_label = macro_f1(labels, predictions)
    none_total = sum(1 for actual in labels if actual == "none")
    none_fp = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == "none" and predicted != "none")

    model_dir = Path(args.model_dir)
    if model_dir.exists():
        shutil.rmtree(model_dir)
    model.save_pretrained(str(model_dir))
    model_size_bytes = directory_size(model_dir)

    report = {
        "model": args.model,
        "label_mode": args.label_mode,
        "seed": args.seed,
        "test_ids": args.test_ids,
        "fixtures": len(rows),
        "train_rows": len(train_rows),
        "test_rows": len(test_rows),
        "labels": dict(sorted(Counter(str(row["label"]) for row in rows).items())),
        "test_labels": dict(sorted(Counter(labels).items())),
        "accuracy": round(correct / len(labels), 4) if labels else 0.0,
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_fp / none_total, 4) if none_total else 0.0,
        "per_label": per_label,
        "confusion": confusion_counts(labels, predictions),
        "train_seconds": round(train_seconds, 2),
        "predict_seconds": round(predict_seconds, 2),
        "model_dir": str(model_dir),
        "model_size_bytes": model_size_bytes,
        "examples": [
            {
                "id": row.get("id"),
                "actual": actual,
                "predicted": predicted,
            }
            for row, actual, predicted in zip(test_rows, labels, predictions, strict=True)
        ],
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("session-section SetFit eval report")
        print(f"model: {report['model']}")
        print(f"fixtures: {report['fixtures']}")
        print(f"train/test: {report['train_rows']}/{report['test_rows']}")
        print(f"accuracy: {report['accuracy']}")
        print(f"macro f1: {report['macro_f1']}")
        print(f"none false-positive rate: {report['none_false_positive_rate']}")
        print(f"train seconds: {report['train_seconds']}")
        print(f"predict seconds: {report['predict_seconds']}")
        print(f"model size bytes: {report['model_size_bytes']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
