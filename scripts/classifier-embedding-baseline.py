#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "sentence-transformers>=3.0,<6",
# ]
# ///
from __future__ import annotations

import argparse
import json
import math
import statistics
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_FIXTURES = [
    "src/classifiers/eval-fixtures/reaction-event.json",
    "packages/ax-classifier-direction-event/eval-fixtures/direction-event.json",
    "src/classifiers/eval-fixtures/correction-event.json",
    "packages/ax-classifier-verification-event/eval-fixtures/verification-event.json",
]


@dataclass(frozen=True)
class Example:
    id: str
    suite: str
    name: str
    text: str
    label: str
    target: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AX classifier embedding-similarity baseline.")
    parser.add_argument("--fixtures", action="append", default=[], help="Fixture JSON path. Can be repeated.")
    parser.add_argument("--windows", default=".ax/experiments/model-windows-e1.jsonl", help="Model-ready window JSONL from E1.")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2", help="Sentence Transformer model name/path.")
    parser.add_argument("--window-limit", type=int, default=1000, help="Maximum exported windows to classify for runtime smoke.")
    parser.add_argument("--k", type=int, default=1, help="Nearest neighbors to use. Currently k=1.")
    parser.add_argument("--out", default=".ax/experiments/embedding-baseline-e2.json", help="JSON report output path.")
    parser.add_argument("--json", action="store_true", help="Print the full JSON report.")
    return parser.parse_args()


def text_block(heading: str, value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    return f"{heading}:\n{text}"


def fixture_text(window: dict[str, Any]) -> str:
    blocks = [
        text_block("USER", window.get("user")),
        text_block("PREVIOUS_ASSISTANT", window.get("previousAssistant")),
        text_block("RECENT_TOOL_FAILURES", "\n".join(window.get("recentToolFailures") or [])),
    ]
    return "\n\n".join(block for block in blocks if block)


def primary_label(case: dict[str, Any]) -> tuple[str, str]:
    expected = case.get("expect") or []
    if not expected:
        return "none", "none"
    first = expected[0]
    return str(first.get("label") or "unknown"), str(first.get("target") or "unknown")


def load_examples(paths: list[str]) -> list[Example]:
    examples: list[Example] = []
    for raw_path in paths:
        path = Path(raw_path)
        if path.suffix == ".jsonl":
            examples.extend(load_jsonl_examples(path))
            continue
        suite = json.loads(path.read_text())
        for case in suite.get("cases", []):
            label, target = primary_label(case)
            name = str(case["name"])
            examples.append(
                Example(
                    id=f"{suite['name']}/{name}",
                    suite=str(suite["name"]),
                    name=name,
                    text=fixture_text(case["window"]),
                    label=label,
                    target=target,
                )
            )
    return examples


def load_jsonl_examples(path: Path) -> list[Example]:
    examples: list[Example] = []
    for line_number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        label = str(row.get("label") or "none")
        target = str(row.get("target") or "none")
        name = str(row.get("name") or row.get("id") or f"line-{line_number}")
        text = str(row.get("text") or "")
        if not text.strip() and isinstance(row.get("window"), dict):
            text = fixture_text(row["window"])
        if not text.strip():
            raise ValueError(f"{path}:{line_number} has no text or window projection")
        examples.append(
            Example(
                id=str(row.get("id") or f"{path.stem}/{name}"),
                suite=str(row.get("suite") or path.stem),
                name=name,
                text=text,
                label=label,
                target=target,
            )
        )
    return examples


def normalize(matrix: Any) -> Any:
    import numpy as np

    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)


def encode(model: Any, texts: list[str]) -> Any:
    import numpy as np

    embeddings = model.encode(texts, batch_size=64, show_progress_bar=False, convert_to_numpy=True)
    return normalize(np.asarray(embeddings, dtype=np.float32))


def nearest_label(
    embeddings: Any,
    examples: list[Example],
    index: int,
) -> tuple[str, float, Example]:
    import numpy as np

    query = embeddings[index]
    candidates = np.delete(embeddings, index, axis=0)
    candidate_examples = examples[:index] + examples[index + 1 :]
    sims = candidates @ query
    best_index = int(np.argmax(sims))
    nearest = candidate_examples[best_index]
    return nearest.label, float(sims[best_index]), nearest


def confusion_counts(labels: list[str], predictions: list[str]) -> dict[str, dict[str, int]]:
    matrix: dict[str, dict[str, int]] = {}
    for actual, predicted in zip(labels, predictions, strict=True):
        matrix.setdefault(actual, {})
        matrix[actual][predicted] = matrix[actual].get(predicted, 0) + 1
    return matrix


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


def classification_metrics(labels: list[str], predictions: list[str]) -> dict[str, Any]:
    correct = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == predicted)
    macro, per_label = macro_f1(labels, predictions)
    none_total = sum(1 for actual in labels if actual == "none")
    none_fp = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == "none" and predicted != "none")
    return {
        "top1_accuracy": round(correct / len(labels), 4) if labels else 0.0,
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_fp / none_total, 4) if none_total else 0.0,
        "per_label": per_label,
        "confusion": confusion_counts(labels, predictions),
    }


def threshold_predictions(raw_predictions: list[str], scores: list[float], threshold: float) -> list[str]:
    return [
        predicted if score >= threshold else "none"
        for predicted, score in zip(raw_predictions, scores, strict=True)
    ]


def threshold_sweep(labels: list[str], raw_predictions: list[str], scores: list[float]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for step in range(0, 20):
        threshold = round(step * 0.05, 2)
        predictions = threshold_predictions(raw_predictions, scores, threshold)
        metrics = classification_metrics(labels, predictions)
        rows.append({
            "threshold": threshold,
            "top1_accuracy": metrics["top1_accuracy"],
            "macro_f1": metrics["macro_f1"],
            "none_false_positive_rate": metrics["none_false_positive_rate"],
        })
    return rows


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(values)
    index = min(len(sorted_values) - 1, max(0, math.ceil((p / 100) * len(sorted_values)) - 1))
    return sorted_values[index]


def load_windows(path: str, limit: int) -> list[dict[str, Any]]:
    file = Path(path)
    if not file.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in file.read_text().splitlines():
        if not line.strip():
            continue
        rows.append(json.loads(line))
        if len(rows) >= limit:
            break
    return rows


def classify_windows_runtime(
    model: Any,
    examples: list[Example],
    example_embeddings: Any,
    windows: list[dict[str, Any]],
) -> dict[str, Any]:
    import numpy as np

    if not windows:
        return {
            "windows": 0,
            "p95_ms_per_1k_windows": 0.0,
            "predicted_label_counts": {},
        }

    batch_ms_per_1k: list[float] = []
    predicted_counts: dict[str, int] = {}
    batch_size = 100
    for start in range(0, len(windows), batch_size):
        batch = windows[start : start + batch_size]
        texts = [str(row.get("text") or "") for row in batch]
        t0 = time.perf_counter()
        embeddings = encode(model, texts)
        sims = embeddings @ example_embeddings.T
        nearest_indices = np.argmax(sims, axis=1)
        elapsed_ms = (time.perf_counter() - t0) * 1000
        batch_ms_per_1k.append(elapsed_ms / len(batch) * 1000)
        for idx in nearest_indices:
            label = examples[int(idx)].label
            predicted_counts[label] = predicted_counts.get(label, 0) + 1

    return {
        "windows": len(windows),
        "p95_ms_per_1k_windows": round(percentile(batch_ms_per_1k, 95), 2),
        "predicted_label_counts": dict(sorted(predicted_counts.items())),
    }


def main() -> int:
    args = parse_args()
    if args.k != 1:
        raise SystemExit("only --k=1 is supported for this baseline")

    from sentence_transformers import SentenceTransformer

    fixture_paths = args.fixtures or DEFAULT_FIXTURES
    examples = load_examples(fixture_paths)
    if len(examples) < 2:
        raise SystemExit("need at least two fixture examples")

    started = time.perf_counter()
    model = SentenceTransformer(args.model)
    model_load_seconds = time.perf_counter() - started

    fixture_embeddings = encode(model, [example.text for example in examples])
    predictions: list[str] = []
    scores: list[float] = []
    nearest_examples: list[dict[str, Any]] = []
    for index, example in enumerate(examples):
        predicted, score, nearest = nearest_label(fixture_embeddings, examples, index)
        predictions.append(predicted)
        scores.append(score)
        nearest_examples.append(
            {
                "id": example.id,
                "actual": example.label,
                "predicted": predicted,
                "score": round(score, 4),
                "nearest": nearest.id,
                "nearest_label": nearest.label,
            }
        )

    labels = [example.label for example in examples]
    metrics = classification_metrics(labels, predictions)
    thresholds = threshold_sweep(labels, predictions, scores)
    best_macro_threshold = max(thresholds, key=lambda row: (row["macro_f1"], row["top1_accuracy"]))
    none_safe_thresholds = [row for row in thresholds if row["none_false_positive_rate"] <= 0.1]
    best_none_safe_threshold = max(none_safe_thresholds, key=lambda row: (row["macro_f1"], row["top1_accuracy"])) if none_safe_thresholds else None
    windows = load_windows(args.windows, args.window_limit)
    runtime = classify_windows_runtime(model, examples, fixture_embeddings, windows)

    report = {
        "model": args.model,
        "fixture_count": len(examples),
        "labels": dict(sorted({label: labels.count(label) for label in set(labels)}.items())),
        "top1_accuracy": metrics["top1_accuracy"],
        "macro_f1": metrics["macro_f1"],
        "none_false_positive_rate": metrics["none_false_positive_rate"],
        "nearest_example_explanation_coverage": 1.0,
        "per_label": metrics["per_label"],
        "confusion": metrics["confusion"],
        "threshold_sweep": thresholds,
        "best_macro_threshold": best_macro_threshold,
        "best_none_safe_threshold": best_none_safe_threshold,
        "examples": nearest_examples,
        "runtime": runtime,
        "model_load_seconds": round(model_load_seconds, 2),
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("classifier embedding baseline report")
        print(f"model: {report['model']}")
        print(f"fixtures: {report['fixture_count']}")
        print(f"top-1 accuracy: {report['top1_accuracy']}")
        print(f"macro f1: {report['macro_f1']}")
        print(f"none false-positive rate: {report['none_false_positive_rate']}")
        print(f"best macro threshold: {report['best_macro_threshold']}")
        print(f"best none-safe threshold: {report['best_none_safe_threshold']}")
        print(f"nearest-example coverage: {report['nearest_example_explanation_coverage']}")
        print(f"windows classified for runtime: {runtime['windows']}")
        print(f"runtime p95 ms / 1k windows: {runtime['p95_ms_per_1k_windows']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
