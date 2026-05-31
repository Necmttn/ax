#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "setfit>=1.1,<2",
#   "transformers>=4.41,<4.57",
# ]
# ///
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import macro_f1, map_label


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sweep confidence calibration for a saved SetFit chunk classifier.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--eval-report", default=".ax/experiments/setfit-session-sections-e3-coarse.json")
    parser.add_argument("--model-dir", default=".ax/experiments/setfit-session-sections-coarse-model")
    parser.add_argument("--out", default=".ax/experiments/setfit-calibration-e14.json")
    parser.add_argument("--label-mode", choices=["fine", "coarse"], default="coarse")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def load_fixture_texts(path: str) -> dict[str, str]:
    rows: dict[str, str] = {}
    for line_number, line in enumerate(Path(path).read_text().splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        row_id = str(row.get("id") or "")
        text = str(row.get("text") or "")
        if not row_id:
            raise ValueError(f"{path}:{line_number} missing id")
        if not text.strip():
            raise ValueError(f"{path}:{line_number} missing text")
        rows[row_id] = text
    return rows


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


def calibrated_label(label: str, confidence: float, threshold: float) -> str:
    if label == "none":
        return "none"
    if confidence < threshold:
        return "none"
    return label


def none_false_positive_rate(labels: list[str], predictions: list[str]) -> float:
    none_total = sum(1 for actual in labels if actual == "none")
    none_fp = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == "none" and predicted != "none")
    return none_fp / none_total if none_total else 0.0


def accuracy(labels: list[str], predictions: list[str]) -> float:
    if not labels:
        return 0.0
    correct = sum(1 for actual, predicted in zip(labels, predictions, strict=True) if actual == predicted)
    return correct / len(labels)


def threshold_metrics(labels: list[str], raw_predictions: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    predictions = [
        calibrated_label(str(row["label"]), float(row["confidence"]), threshold)
        for row in raw_predictions
    ]
    macro, per_label = macro_f1(labels, predictions)
    return {
        "threshold": round(threshold, 4),
        "accuracy": round(accuracy(labels, predictions), 4),
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_false_positive_rate(labels, predictions), 4),
        "prediction_counts": {
            label: predictions.count(label)
            for label in sorted(set(predictions))
        },
        "per_label": per_label,
    }


def sweep_thresholds(labels: list[str], raw_predictions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        threshold_metrics(labels, raw_predictions, threshold / 100)
        for threshold in range(0, 100, 5)
    ]


def build_report(
    eval_report: dict[str, Any],
    fixture_texts: dict[str, str],
    model_dir: str,
    label_mode: str,
) -> dict[str, Any]:
    from setfit import SetFitModel

    examples = eval_report.get("examples") or []
    ids = [str(example.get("id") or "") for example in examples]
    missing = [example_id for example_id in ids if example_id not in fixture_texts]
    if missing:
        raise ValueError(f"missing fixture texts for eval examples: {missing}")

    labels = [map_label(str(example.get("actual") or ""), label_mode) for example in examples]
    model = SetFitModel.from_pretrained(model_dir)
    model_labels = list(model.labels)
    probas = tensor_rows(model.predict_proba([fixture_texts[example_id] for example_id in ids]))
    raw_predictions = []
    for example_id, proba in zip(ids, probas, strict=True):
        label, confidence = best_label(proba, model_labels)
        raw_predictions.append({
            "id": example_id,
            "label": label,
            "confidence": round(confidence, 4),
        })

    thresholds = sweep_thresholds(labels, raw_predictions)
    best_macro = max(thresholds, key=lambda row: (row["macro_f1"], -row["none_false_positive_rate"], row["accuracy"]))
    none_safe = [row for row in thresholds if row["none_false_positive_rate"] < 0.10]
    best_none_safe = max(none_safe, key=lambda row: (row["macro_f1"], row["accuracy"])) if none_safe else None
    base = threshold_metrics(labels, raw_predictions, 0.0)
    return {
        "schema": "ax.setfit_calibration_report.v1",
        "model_dir": model_dir,
        "label_mode": label_mode,
        "examples": len(examples),
        "base": base,
        "best_macro": best_macro,
        "best_none_safe": best_none_safe,
        "thresholds": thresholds,
        "raw_predictions": raw_predictions,
        "decision": "adopt_threshold" if best_none_safe and best_none_safe["macro_f1"] >= 0.75 else "reject_threshold_only_calibration",
    }


def main() -> int:
    args = parse_args()
    report = build_report(
        eval_report=load_json(args.eval_report),
        fixture_texts=load_fixture_texts(args.fixtures),
        model_dir=args.model_dir,
        label_mode=args.label_mode,
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit calibration report")
        print(f"examples: {report['examples']}")
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
