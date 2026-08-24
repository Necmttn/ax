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
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import apply_label_mode, load_rows  # noqa: E402
from two_stage import actionable_rows, binary_rows, final_predictions, train_predict  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train two-stage SetFit on curated fixtures and predict a blind session-section pack.")
    parser.add_argument("--train-fixtures", default=".ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl")
    parser.add_argument("--blind-fixtures", default=".ax/experiments/blind-session-section-fixtures-e46.jsonl")
    parser.add_argument("--model", default="sentence-transformers/all-MiniLM-L6-v2")
    parser.add_argument("--out", default=".ax/experiments/blind-session-section-predictions-e48.jsonl")
    parser.add_argument("--report", default=".ax/experiments/blind-session-section-predictions-e48-report.json")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--label-mode", choices=["fine", "coarse"], default="coarse")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")


def family_test_rows(rows: list[dict[str, Any]], binary_predictions: list[str]) -> list[dict[str, Any]]:
    return [
        row
        for row, prediction in zip(rows, binary_predictions, strict=True)
        if prediction == "actionable"
    ]


def details_by_id(details: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(detail.get("id")): detail for detail in details}


def prediction_records(
    rows: list[dict[str, Any]],
    final_predictions: list[str],
    binary_details: list[dict[str, Any]],
    family_details: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    binary_by_id = details_by_id(binary_details)
    family_by_id = details_by_id(family_details)
    records: list[dict[str, Any]] = []
    for row, prediction in zip(rows, final_predictions, strict=True):
        row_id = str(row["id"])
        binary = binary_by_id.get(row_id, {})
        family = family_by_id.get(row_id)
        records.append({
            "id": row_id,
            "source_window_id": row.get("source_window_id"),
            "predicted": prediction,
            "binary_predicted": binary.get("predicted"),
            "binary_confidence": binary.get("confidence"),
            "family_predicted": family.get("predicted") if family else None,
            "family_confidence": family.get("confidence") if family else None,
        })
    return records


def build_report(
    records: list[dict[str, Any]],
    train_rows: int,
    blind_rows: int,
    model: str,
    label_mode: str,
    train_seconds: float,
    predict_seconds: float,
) -> dict[str, Any]:
    failures = []
    if len(records) != blind_rows:
        failures.append("prediction rows do not match blind rows")
    return {
        "schema": "ax.blind_session_section_predictions.v1",
        "model": model,
        "label_mode": label_mode,
        "train_rows": train_rows,
        "blind_rows": blind_rows,
        "predicted_rows": len(records),
        "prediction_counts": dict(sorted(Counter(str(record["predicted"]) for record in records).items())),
        "train_seconds": round(train_seconds, 2),
        "predict_seconds": round(predict_seconds, 2),
        "failures": failures,
        "decision": "ready_for_blind_eval_after_labeling" if not failures else "needs_prediction_work",
    }


def predict_blind(
    train_rows: list[dict[str, Any]],
    blind_rows: list[dict[str, Any]],
    model: str,
    epochs: int,
    batch_size: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    binary_predictions, binary_details, binary_train_seconds, binary_predict_seconds = train_predict(
        binary_rows(train_rows),
        blind_rows,
        model,
        epochs,
        batch_size,
    )
    family_rows = family_test_rows(blind_rows, binary_predictions)
    family_predictions, family_details, family_train_seconds, family_predict_seconds = train_predict(
        actionable_rows(train_rows),
        family_rows,
        model,
        epochs,
        batch_size,
    ) if family_rows else ([], [], 0.0, 0.0)
    final = final_predictions(binary_predictions, family_predictions)
    records = prediction_records(blind_rows, final, binary_details, family_details)
    timing = {
        "train_seconds": binary_train_seconds + family_train_seconds,
        "predict_seconds": binary_predict_seconds + family_predict_seconds,
    }
    return records, timing


def main() -> int:
    args = parse_args()
    train_rows = apply_label_mode(load_rows(args.train_fixtures), args.label_mode)
    blind_rows = load_jsonl(args.blind_fixtures)
    records, timing = predict_blind(
        train_rows,
        blind_rows,
        args.model,
        args.epochs,
        args.batch_size,
    )
    write_jsonl(args.out, records)
    report = build_report(
        records,
        train_rows=len(train_rows),
        blind_rows=len(blind_rows),
        model=args.model,
        label_mode=args.label_mode,
        train_seconds=float(timing["train_seconds"]),
        predict_seconds=float(timing["predict_seconds"]),
    )
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind session-section prediction report")
        print(f"train rows: {report['train_rows']}")
        print(f"blind rows: {report['blind_rows']}")
        print(f"prediction counts: {report['prediction_counts']}")
        print(f"train seconds: {report['train_seconds']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {args.out}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
