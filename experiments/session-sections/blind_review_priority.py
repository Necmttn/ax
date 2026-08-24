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

from blind_label_review import load_json, write_json  # noqa: E402


CONTROL_PATTERNS = (
    "what's next",
    "whats next",
    "what was",
    "can i merge",
    "is there still",
    "status",
    "git status",
    "continue",
)

CONTEXT_DUMP_PATTERNS = (
    "<instructions>",
    "agents.md instructions",
    "you are implementing task",
    "context:",
    "files you own",
)

ENVIRONMENT_HINTS = (
    "uv",
    "docker",
    "nix",
    "surreal",
    "db",
    "package",
    "install",
    "dependency",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prioritize blind label suggestions for human review.")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--suggestions", default=".ax/experiments/blind-session-section-label-suggestions-e51.json")
    parser.add_argument("--out", default=".ax/experiments/blind-session-section-review-priority-e52.json")
    parser.add_argument("--brief", default=".ax/experiments/blind-session-section-review-priority-e52.md")
    parser.add_argument("--report", default=".ax/experiments/blind-session-section-review-priority-e52-report.json")
    parser.add_argument("--limit", type=int, default=15)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def contains_any(text: str, patterns: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in patterns)


def suggestion_by_id(suggestions: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item.get("id")): item for item in suggestions.get("items", [])}


def risk_reasons(item: dict[str, Any], suggestion: dict[str, Any]) -> list[str]:
    text = str(item.get("text") or "")
    label = str(suggestion.get("suggested_label") or "")
    reasons: list[str] = []
    if suggestion.get("confidence_bucket") == "low":
        reasons.append("low_confidence")
    elif suggestion.get("confidence_bucket") == "medium":
        reasons.append("medium_confidence")
    if contains_any(text, CONTROL_PATTERNS):
        reasons.append("possible_none_control_turn")
    if contains_any(text, CONTEXT_DUMP_PATTERNS):
        reasons.append("context_dump")
    if label == "environment_or_preference_signal" and not contains_any(text, ENVIRONMENT_HINTS):
        reasons.append("environment_overprediction_risk")
    if label != "none" and not str(item.get("evidence_refs") or ""):
        reasons.append("no_evidence_refs")
    return reasons


RISK_WEIGHTS = {
    "low_confidence": 5,
    "possible_none_control_turn": 4,
    "context_dump": 4,
    "environment_overprediction_risk": 3,
    "medium_confidence": 2,
    "no_evidence_refs": 1,
}


def priority_score(reasons: list[str]) -> int:
    return sum(RISK_WEIGHTS.get(reason, 1) for reason in reasons)


def priority_item(item: dict[str, Any], suggestion: dict[str, Any]) -> dict[str, Any]:
    reasons = risk_reasons(item, suggestion)
    return {
        "id": str(item.get("id")),
        "priority_score": priority_score(reasons),
        "risk_reasons": reasons,
        "suggested_label": suggestion.get("suggested_label"),
        "suggested_target": suggestion.get("suggested_target"),
        "confidence_bucket": suggestion.get("confidence_bucket"),
        "binary_confidence": suggestion.get("binary_confidence"),
        "family_confidence": suggestion.get("family_confidence"),
        "current_label": item.get("label"),
        "current_target": item.get("target"),
        "source_window_id": item.get("source_window_id"),
        "text_excerpt": excerpt(str(item.get("text") or "")),
    }


def excerpt(text: str, limit: int = 320) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3].rstrip() + "..."


def build_priorities(review: dict[str, Any], suggestions: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = suggestion_by_id(suggestions)
    priorities = [
        priority_item(item, by_id.get(str(item.get("id")), {}))
        for item in review.get("items", [])
    ]
    priorities.sort(key=lambda item: (-int(item["priority_score"]), str(item["id"])))
    return priorities


def build_report(priorities: list[dict[str, Any]], review_items: int, suggestions: int, limit: int) -> dict[str, Any]:
    failures = []
    if len(priorities) != review_items:
        failures.append("priority count does not match review items")
    reason_counts = Counter(
        reason
        for item in priorities
        for reason in item.get("risk_reasons", [])
    )
    return {
        "schema": "ax.blind_session_section_review_priority_report.v1",
        "review_items": review_items,
        "suggestions": suggestions,
        "priorities": len(priorities),
        "top_priority_count": min(limit, len(priorities)),
        "risk_reason_counts": dict(sorted(reason_counts.items())),
        "max_priority_score": max((int(item.get("priority_score", 0)) for item in priorities), default=0),
        "failures": failures,
        "decision": "ready_for_prioritized_review" if not failures else "needs_priority_work",
    }


def render_markdown(priorities: list[dict[str, Any]], limit: int) -> str:
    lines = [
        "# Blind Review Priority Queue",
        "",
        "Review these rows first. High priority means the suggestion is more likely to be wrong or more likely to affect the blind gate.",
        "",
    ]
    for index, item in enumerate(priorities[:limit], start=1):
        reasons = ", ".join(f"`{reason}`" for reason in item.get("risk_reasons", [])) or "_none_"
        lines.extend([
            f"## {index}. {item['id']}",
            "",
            f"- Priority score: `{item['priority_score']}`",
            f"- Risk reasons: {reasons}",
            f"- Suggested label: `{item.get('suggested_label')}`",
            f"- Suggested target: `{item.get('suggested_target')}`",
            f"- Confidence bucket: `{item.get('confidence_bucket')}`",
            f"- Binary confidence: `{item.get('binary_confidence')}`",
            f"- Family confidence: `{item.get('family_confidence')}`",
            f"- Current label: `{item.get('current_label')}`",
            f"- Current target: `{item.get('current_target')}`",
            f"- Source window: `{item.get('source_window_id')}`",
            "",
            f"> {item.get('text_excerpt')}",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    review = load_json(args.review)
    suggestions = load_json(args.suggestions)
    priorities = build_priorities(review, suggestions)
    write_json(args.out, {"schema": "ax.blind_session_section_review_priority.v1", "items": priorities})
    brief = Path(args.brief)
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text(render_markdown(priorities, args.limit))
    report = build_report(priorities, len(review.get("items", [])), len(suggestions.get("items", [])), args.limit)
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind review priority report")
        print(f"priorities: {report['priorities']}")
        print(f"top priority count: {report['top_priority_count']}")
        print(f"risk reasons: {report['risk_reason_counts']}")
        print(f"decision: {report['decision']}")
        print(f"out: {args.out}")
        print(f"brief: {args.brief}")
    return 0 if report["decision"] == "ready_for_prioritized_review" else 1


if __name__ == "__main__":
    raise SystemExit(main())
