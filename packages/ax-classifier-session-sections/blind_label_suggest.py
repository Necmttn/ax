#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_fixture_pack import ALLOWED_LABELS  # noqa: E402
from blind_label_review import load_json, load_jsonl, write_json  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate non-authoritative label suggestions for a blind review queue.")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--predictions", default=".ax/experiments/blind-session-section-predictions-e48.jsonl")
    parser.add_argument("--out", default=".ax/experiments/blind-session-section-label-suggestions-e51.json")
    parser.add_argument("--brief", default=".ax/experiments/blind-session-section-label-suggestions-e51.md")
    parser.add_argument("--report", default=".ax/experiments/blind-session-section-label-suggestions-e51-report.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def prediction_by_id(predictions: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(prediction.get("id")): prediction for prediction in predictions}


def contains(text: str, *patterns: str) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in patterns)


def target_hint(item: dict[str, Any], label: str) -> str:
    text = str(item.get("text") or "")
    if label == "none":
        if contains(text, "what was", "what is", "what's next", "status", "git status"):
            return "context_recall"
        return "none"
    if label == "environment_or_preference_signal":
        if contains(text, "uv", "docker", "nix", "surreal", "db", "package", "install", "dependency"):
            return "dev_environment"
        if contains(text, "expensive", "bruteforce", "cost"):
            return "cost"
        return "workflow_state"
    if label == "verification_or_recovery_signal":
        if contains(text, "benchmark", "result", "results", "test", "verify", "proof", "show me"):
            return "benchmark_required"
        return "regression_guard"
    if label == "correction_or_rejection_signal":
        if contains(text, "don't", "dont", "not", "wrong", "isn't", "isnt", "cancelled"):
            return "workflow_state"
        return "none"
    if label == "approval":
        return "continue"
    return "none"


def confidence_bucket(prediction: dict[str, Any]) -> str:
    scores = [
        float(prediction[key])
        for key in ("binary_confidence", "family_confidence")
        if prediction.get(key) is not None
    ]
    confidence = min(scores) if scores else 0.0
    if confidence >= 0.75:
        return "high"
    if confidence >= 0.55:
        return "medium"
    return "low"


def suggestion_rationale(item: dict[str, Any], prediction: dict[str, Any], target: str) -> str:
    label = str(prediction.get("predicted"))
    bucket = confidence_bucket(prediction)
    return (
        f"model predicted `{label}` with {bucket} confidence; target hint `{target}` "
        "comes from text keywords and must be accepted or edited by a reviewer."
    )


def suggestion_for_item(item: dict[str, Any], prediction: dict[str, Any] | None) -> dict[str, Any]:
    label = str(prediction.get("predicted")) if prediction else "none"
    if label not in set(ALLOWED_LABELS):
        label = "none"
    target = target_hint(item, label)
    return {
        "id": str(item.get("id")),
        "current_label": str(item.get("label") or "__pending__"),
        "current_target": str(item.get("target") or "__pending__"),
        "suggested_label": label,
        "suggested_target": target,
        "confidence_bucket": confidence_bucket(prediction or {}),
        "binary_confidence": None if prediction is None else prediction.get("binary_confidence"),
        "family_confidence": None if prediction is None else prediction.get("family_confidence"),
        "rationale": suggestion_rationale(item, prediction or {"predicted": label}, target),
    }


def build_suggestions(review: dict[str, Any], predictions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = prediction_by_id(predictions)
    return [
        suggestion_for_item(item, by_id.get(str(item.get("id"))))
        for item in review.get("items", [])
    ]


def build_report(suggestions: list[dict[str, Any]], review_items: int, predictions: int) -> dict[str, Any]:
    failures = []
    if len(suggestions) != review_items:
        failures.append("suggestion count does not match review items")
    return {
        "schema": "ax.blind_session_section_label_suggestions_report.v1",
        "review_items": review_items,
        "predictions": predictions,
        "suggestions": len(suggestions),
        "suggested_label_counts": dict(sorted(Counter(str(item["suggested_label"]) for item in suggestions).items())),
        "confidence_buckets": dict(sorted(Counter(str(item["confidence_bucket"]) for item in suggestions).items())),
        "failures": failures,
        "decision": "ready_for_human_acceptance" if not failures else "needs_suggestion_work",
    }


def render_markdown(suggestions: list[dict[str, Any]], review: dict[str, Any]) -> str:
    by_id = {str(item.get("id")): item for item in review.get("items", [])}
    lines = [
        "# Blind Label Suggestions",
        "",
        "These are non-authoritative suggestions. Copy a label, target, and note into the E49 review only after human acceptance.",
        "",
    ]
    for index, suggestion in enumerate(suggestions, start=1):
        item = by_id.get(str(suggestion["id"]), {})
        excerpt = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
        if len(excerpt) > 360:
            excerpt = excerpt[:357].rstrip() + "..."
        lines.extend([
            f"## {index}. {suggestion['id']}",
            "",
            f"- Suggested label: `{suggestion['suggested_label']}`",
            f"- Suggested target: `{suggestion['suggested_target']}`",
            f"- Confidence bucket: `{suggestion['confidence_bucket']}`",
            f"- Binary confidence: `{suggestion['binary_confidence']}`",
            f"- Family confidence: `{suggestion['family_confidence']}`",
            f"- Rationale: {suggestion['rationale']}",
            f"- Current review label: `{suggestion['current_label']}`",
            f"- Current review target: `{suggestion['current_target']}`",
            "",
            f"> {excerpt}",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    review = load_json(args.review)
    predictions = load_jsonl(args.predictions)
    suggestions = build_suggestions(review, predictions)
    write_json(args.out, {"schema": "ax.blind_session_section_label_suggestions.v1", "items": suggestions})
    brief = Path(args.brief)
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text(render_markdown(suggestions, review))
    report = build_report(suggestions, len(review.get("items", [])), len(predictions))
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind label suggestions report")
        print(f"suggestions: {report['suggestions']}")
        print(f"label counts: {report['suggested_label_counts']}")
        print(f"confidence buckets: {report['confidence_buckets']}")
        print(f"decision: {report['decision']}")
        print(f"out: {args.out}")
        print(f"brief: {args.brief}")
    return 0 if report["decision"] == "ready_for_human_acceptance" else 1


if __name__ == "__main__":
    raise SystemExit(main())
