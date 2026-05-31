#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_gate_eval import build_report as build_gate_report  # noqa: E402
from blind_gate_eval import load_jsonl as load_gate_jsonl  # noqa: E402
from blind_label_review import (  # noqa: E402
    apply_review_to_fixtures,
    evaluate_review,
    load_json,
    load_jsonl,
    sync_review_from_markdown,
    write_json,
    write_jsonl,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync blind labels and run blind gate-stack eval once review is ready.")
    parser.add_argument("--fixtures", default=".ax/experiments/blind-session-section-fixtures-e46.jsonl")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--brief", default=".ax/experiments/blind-session-section-label-review-e49.md")
    parser.add_argument("--predictions", default=".ax/experiments/blind-session-section-predictions-e48.jsonl")
    parser.add_argument("--labeled-out", default=".ax/experiments/blind-session-section-fixtures-e50-labeled.jsonl")
    parser.add_argument("--eval-out", default=".ax/experiments/blind-gate-stack-eval-e50.json")
    parser.add_argument("--out", default=".ax/experiments/blind-eval-roundtrip-e50-report.json")
    parser.add_argument("--sync", action="store_true", help="Sync labels from the Markdown brief before evaluating.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def build_pending_report(label_report: dict[str, Any], fixtures: str, predictions: str) -> dict[str, Any]:
    return {
        "schema": "ax.blind_eval_roundtrip.v1",
        "fixtures": fixtures,
        "predictions": predictions,
        "label_review_decision": label_report.get("decision"),
        "review_items": label_report.get("items"),
        "pending_labels": label_report.get("pending"),
        "label_review_failures": label_report.get("failures", []),
        "decision": "needs_blind_label_review",
    }


def build_ready_report(
    label_report: dict[str, Any],
    gate_report: dict[str, Any],
    fixtures: str,
    predictions: str,
    eval_out: str,
) -> dict[str, Any]:
    return {
        "schema": "ax.blind_eval_roundtrip.v1",
        "fixtures": fixtures,
        "predictions": predictions,
        "eval_out": eval_out,
        "label_review_decision": label_report.get("decision"),
        "review_items": label_report.get("items"),
        "pending_labels": label_report.get("pending"),
        "blind_gate_decision": gate_report.get("decision"),
        "blind_gate_metrics": gate_report.get("metrics", {}),
        "unsafe_none_miss_count": gate_report.get("unsafe_none_miss_count"),
        "remaining_miss_count": gate_report.get("remaining_miss_count"),
        "decision": gate_report.get("decision"),
    }


def load_or_sync_review(review_path: str, brief_path: str, should_sync: bool) -> dict[str, Any]:
    review = load_json(review_path)
    if should_sync:
        review = sync_review_from_markdown(review, Path(brief_path).read_text())
        write_json(review_path, review)
    return review


def run_roundtrip(args: argparse.Namespace) -> dict[str, Any]:
    source_rows = load_jsonl(args.fixtures)
    review = load_or_sync_review(args.review, args.brief, args.sync)
    labeled_rows = apply_review_to_fixtures(source_rows, review)
    write_jsonl(args.labeled_out, labeled_rows)
    label_report = evaluate_review(review)
    if label_report["decision"] != "ready_for_blind_gate_eval":
        return build_pending_report(label_report, args.labeled_out, args.predictions)

    gate_report = build_gate_report(load_gate_jsonl(args.labeled_out), load_gate_jsonl(args.predictions))
    write_json(args.eval_out, gate_report)
    return build_ready_report(label_report, gate_report, args.labeled_out, args.predictions, args.eval_out)


def main() -> int:
    args = parse_args()
    report = run_roundtrip(args)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind eval roundtrip report")
        print(f"label review: {report['label_review_decision']}")
        print(f"pending labels: {report['pending_labels']}")
        if "blind_gate_decision" in report:
            print(f"blind gate: {report['blind_gate_decision']}")
            print(f"metrics: {report['blind_gate_metrics']}")
        print(f"decision: {report['decision']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "candidate_blind_gate_stack" else 1


if __name__ == "__main__":
    raise SystemExit(main())
