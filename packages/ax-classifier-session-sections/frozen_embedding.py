#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "numpy>=1.26",
#   "scikit-learn>=1.5",
#   "sentence-transformers>=3.0,<6",
# ]
# ///
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import apply_label_mode, load_rows, read_test_ids  # noqa: E402
from robustness import (  # noqa: E402
    failure_reasons,
    metrics_for_predictions,
    split_rows,
    summarize_runs,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate frozen embedding classifiers for AX session-section chunks.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--classifier", choices=["logistic", "centroid"], default="logistic")
    parser.add_argument("--out", default=".ax/experiments/frozen-embedding-e24.json")
    parser.add_argument("--seeds", default="7,13,42")
    parser.add_argument("--label-mode", choices=["fine", "coarse"], default="coarse")
    parser.add_argument("--calibration-threshold", type=float, default=None)
    parser.add_argument("--test-ids", default=None, help="Optional JSON or line-delimited file of fixed held-out fixture ids.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def parse_seeds(value: str) -> list[int]:
    seeds = [int(part.strip()) for part in value.split(",") if part.strip()]
    if not seeds:
        raise ValueError("--seeds must include at least one integer")
    return seeds


def normalize_vector(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm <= 1e-12:
        return [0.0 for _value in vector]
    return [value / norm for value in vector]


def dot(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right, strict=True))


def softmax(scores: list[float]) -> list[float]:
    if not scores:
        return []
    offset = max(scores)
    exps = [math.exp(score - offset) for score in scores]
    total = sum(exps)
    return [value / total for value in exps]


def predict_centroid_labels(
    train_vectors: list[list[float]],
    train_labels: list[str],
    test_vectors: list[list[float]],
) -> list[dict[str, Any]]:
    label_vectors: dict[str, list[list[float]]] = defaultdict(list)
    for vector, label in zip(train_vectors, train_labels, strict=True):
        label_vectors[label].append(normalize_vector(vector))

    labels = sorted(label_vectors)
    centroids = []
    for label in labels:
        vectors = label_vectors[label]
        summed = [sum(vector[index] for vector in vectors) for index in range(len(vectors[0]))]
        centroids.append(normalize_vector([value / len(vectors) for value in summed]))

    predictions: list[dict[str, Any]] = []
    for vector in test_vectors:
        normalized = normalize_vector(vector)
        scores = [dot(normalized, centroid) for centroid in centroids]
        probabilities = softmax(scores)
        ranked = sorted(range(len(labels)), key=lambda index: scores[index], reverse=True)
        best = ranked[0]
        second_score = scores[ranked[1]] if len(ranked) > 1 else 0.0
        predictions.append({
            "label": labels[best],
            "confidence": round(probabilities[best], 4),
            "margin": round(scores[best] - second_score, 4),
        })
    return predictions


def predict_logistic_labels(
    train_vectors: list[list[float]],
    train_labels: list[str],
    test_vectors: list[list[float]],
    seed: int,
) -> list[dict[str, Any]]:
    from sklearn.linear_model import LogisticRegression

    classifier = LogisticRegression(
        max_iter=1000,
        class_weight="balanced",
        random_state=seed,
    )
    classifier.fit(train_vectors, train_labels)
    probabilities = classifier.predict_proba(test_vectors)
    labels = [str(label) for label in classifier.classes_]
    predictions: list[dict[str, Any]] = []
    for row in probabilities.tolist():
        ranked = sorted(range(len(labels)), key=lambda index: row[index], reverse=True)
        best = ranked[0]
        second = row[ranked[1]] if len(ranked) > 1 else 0.0
        predictions.append({
            "label": labels[best],
            "confidence": round(float(row[best]), 4),
            "margin": round(float(row[best] - second), 4),
        })
    return predictions


def apply_confidence_threshold(predictions: list[dict[str, Any]], threshold: float | None) -> list[str]:
    labels: list[str] = []
    for prediction in predictions:
        label = str(prediction["label"])
        confidence = float(prediction["confidence"])
        if threshold is not None and label != "none" and confidence < threshold:
            labels.append("none")
        else:
            labels.append(label)
    return labels


def build_run_report(
    seed: int,
    train_rows: int,
    test_rows: list[dict[str, Any]],
    labels: list[str],
    predictions: list[str],
    scored_predictions: list[dict[str, Any]],
    train_seconds: float,
    predict_seconds: float,
    calibration_threshold: float | None,
) -> dict[str, Any]:
    raw = metrics_for_predictions(test_rows, labels, predictions, train_seconds, predict_seconds)
    report = {
        "seed": seed,
        "train_rows": train_rows,
        "test_rows": len(test_rows),
        **raw,
        "raw_predictions_with_confidence": [
            {
                "id": row.get("id"),
                "actual": actual,
                "predicted": scored["label"],
                "confidence": scored["confidence"],
                "margin": scored["margin"],
            }
            for row, actual, scored in zip(test_rows, labels, scored_predictions, strict=True)
        ],
    }
    if calibration_threshold is not None:
        calibrated_predictions = apply_confidence_threshold(scored_predictions, calibration_threshold)
        report["calibrated"] = {
            "threshold": calibration_threshold,
            **metrics_for_predictions(test_rows, labels, calibrated_predictions, train_seconds, predict_seconds),
        }
    return report


def encode_rows(model_name: str, rows: list[dict[str, Any]]) -> tuple[list[list[float]], float]:
    from sentence_transformers import SentenceTransformer

    started = time.perf_counter()
    model = SentenceTransformer(model_name)
    embeddings = model.encode(
        [str(row["text"]) for row in rows],
        batch_size=64,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    elapsed = time.perf_counter() - started
    return [[float(value) for value in vector] for vector in embeddings.tolist()], elapsed


def select_vectors(rows: list[dict[str, Any]], row_vectors: dict[str, list[float]]) -> list[list[float]]:
    return [row_vectors[str(row["id"])] for row in rows]


def eval_seed(
    rows: list[dict[str, Any]],
    row_vectors: dict[str, list[float]],
    seed: int,
    classifier_name: str,
    test_ids: set[str] | None,
    calibration_threshold: float | None,
) -> dict[str, Any]:
    train_rows, test_rows = split_rows(rows, seed, test_ids)
    train_vectors = select_vectors(train_rows, row_vectors)
    test_vectors = select_vectors(test_rows, row_vectors)
    train_labels = [str(row["label"]) for row in train_rows]
    labels = [str(row["label"]) for row in test_rows]

    train_started = time.perf_counter()
    if classifier_name == "centroid":
        scored_predictions = predict_centroid_labels(train_vectors, train_labels, test_vectors)
    elif classifier_name == "logistic":
        scored_predictions = predict_logistic_labels(train_vectors, train_labels, test_vectors, seed)
    else:
        raise ValueError(f"unknown classifier: {classifier_name}")
    train_seconds = time.perf_counter() - train_started

    predict_started = time.perf_counter()
    predictions = [str(prediction["label"]) for prediction in scored_predictions]
    predict_seconds = time.perf_counter() - predict_started
    return build_run_report(
        seed=seed,
        train_rows=len(train_rows),
        test_rows=test_rows,
        labels=labels,
        predictions=predictions,
        scored_predictions=scored_predictions,
        train_seconds=train_seconds,
        predict_seconds=predict_seconds,
        calibration_threshold=calibration_threshold,
    )


def calibrated_runs(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [run["calibrated"] for run in runs if "calibrated" in run]


def main() -> int:
    args = parse_args()
    seeds = parse_seeds(args.seeds)
    rows = apply_label_mode(load_rows(args.fixtures), args.label_mode)
    test_ids = read_test_ids(args.test_ids) if args.test_ids else None
    vectors, encode_seconds = encode_rows(args.model, rows)
    row_vectors = {str(row["id"]): vector for row, vector in zip(rows, vectors, strict=True)}
    runs = [
        eval_seed(rows, row_vectors, seed, args.classifier, test_ids, args.calibration_threshold)
        for seed in seeds
    ]
    summary = summarize_runs(runs)
    calibrated = calibrated_runs(runs)
    calibrated_summary = summarize_runs(calibrated) if calibrated else None
    gate_summary = calibrated_summary or summary
    failures = failure_reasons(gate_summary)
    report = {
        "schema": "ax.frozen_embedding_robustness_report.v1",
        "model": args.model,
        "classifier": args.classifier,
        "label_mode": args.label_mode,
        "fixtures": len(rows),
        "labels": dict(sorted(Counter(str(row["label"]) for row in rows).items())),
        "seeds": seeds,
        "test_ids": args.test_ids,
        "calibration_threshold": args.calibration_threshold,
        "encode_seconds": round(encode_seconds, 2),
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
        print("Frozen embedding robustness report")
        print(f"model: {report['model']}")
        print(f"classifier: {report['classifier']}")
        print(f"fixtures: {report['fixtures']}")
        print(f"label mode: {report['label_mode']}")
        print(f"seeds: {report['seeds']}")
        print(f"encode seconds: {report['encode_seconds']}")
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
