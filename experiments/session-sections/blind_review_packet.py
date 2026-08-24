#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_label_review import load_json, write_json  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build one read-only packet for blind label review context.")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--suggestions", default=".ax/experiments/blind-session-section-label-suggestions-e51.json")
    parser.add_argument("--priorities", default=".ax/experiments/blind-session-section-review-priority-e52.json")
    parser.add_argument("--hard-negatives", default=".ax/experiments/blind-hard-negative-candidates-e54.json")
    parser.add_argument("--out", default=".ax/experiments/blind-review-packet-e61.json")
    parser.add_argument("--brief", default=".ax/experiments/blind-review-packet-e61.md")
    parser.add_argument("--report", default=".ax/experiments/blind-review-packet-e61-report.json")
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def by_id(rows: list[dict[str, Any]], key: str = "id") -> dict[str, dict[str, Any]]:
    return {str(row.get(key)): row for row in rows}


def hard_negative_by_source_id(hard_negatives: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return by_id(list(hard_negatives.get("items", [])), "source_blind_id")


def excerpt(text: str, limit: int = 420) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3].rstrip() + "..."


def fenced_text(value: str) -> str:
    return f"```text\n{value.rstrip()}\n```"


def packet_item(
    review: dict[str, Any],
    suggestion: dict[str, Any] | None = None,
    priority: dict[str, Any] | None = None,
    hard_negative: dict[str, Any] | None = None,
) -> dict[str, Any]:
    suggestion = suggestion or {}
    priority = priority or {}
    hard_negative = hard_negative or {}
    text = str(review.get("text") or "")
    return {
        "id": str(review.get("id")),
        "source_window_id": review.get("source_window_id"),
        "source_turn": review.get("source_turn"),
        "source_session": review.get("source_session"),
        "source_seq": review.get("source_seq"),
        "approx_tokens": int(review.get("approx_tokens") or 0),
        "evidence_refs": list(review.get("evidence_refs", [])),
        "label": review.get("label"),
        "target": review.get("target"),
        "review_notes": review.get("review_notes"),
        "suggested_label": suggestion.get("suggested_label"),
        "suggested_target": suggestion.get("suggested_target"),
        "confidence_bucket": suggestion.get("confidence_bucket"),
        "binary_confidence": suggestion.get("binary_confidence"),
        "family_confidence": suggestion.get("family_confidence"),
        "priority_score": int(priority.get("priority_score") or 0),
        "risk_reasons": list(priority.get("risk_reasons", [])),
        "hard_negative_candidate_id": hard_negative.get("id"),
        "hard_negative_status": hard_negative.get("status"),
        "hard_negative_review_notes": hard_negative.get("review_notes"),
        "hard_negative_proposed_label": hard_negative.get("proposed_label"),
        "hard_negative_proposed_target": hard_negative.get("proposed_target"),
        "hard_negative_review_instruction": hard_negative.get("review_instruction"),
        "text": text,
        "text_excerpt": priority.get("text_excerpt") or excerpt(text),
    }


def build_packet(
    review: dict[str, Any],
    suggestions: dict[str, Any],
    priorities: dict[str, Any],
    hard_negatives: dict[str, Any],
) -> dict[str, Any]:
    suggestions_by_id = by_id(list(suggestions.get("items", [])))
    priorities_by_id = by_id(list(priorities.get("items", [])))
    hard_negatives_by_source = hard_negative_by_source_id(hard_negatives)
    items = [
        packet_item(
            item,
            suggestions_by_id.get(str(item.get("id"))),
            priorities_by_id.get(str(item.get("id"))),
            hard_negatives_by_source.get(str(item.get("id"))),
        )
        for item in review.get("items", [])
    ]
    items.sort(key=lambda item: (-int(item.get("priority_score") or 0), str(item.get("id"))))
    return {
        "schema": "ax.blind_review_packet.v1",
        "instructions": (
            "Use this packet for review context only. Accepted labels remain authoritative in E49; "
            "accepted hard negatives remain authoritative in E54."
        ),
        "items": items,
    }


def build_report(packet: dict[str, Any]) -> dict[str, Any]:
    items = list(packet.get("items", []))
    pending_labels = [
        item
        for item in items
        if str(item.get("label")) == "__pending__" or str(item.get("target")) == "__pending__"
    ]
    hard_negative_candidates = [
        item
        for item in items
        if item.get("hard_negative_status") == "pending_human_acceptance"
    ]
    high_priority = [item for item in items if int(item.get("priority_score") or 0) >= 5]
    failures = []
    if not items:
        failures.append("packet has no review items")
    return {
        "schema": "ax.blind_review_packet_report.v1",
        "items": len(items),
        "pending_labels": len(pending_labels),
        "hard_negative_candidates": len(hard_negative_candidates),
        "high_priority_count": len(high_priority),
        "failures": failures,
        "decision": "ready_for_consolidated_review" if not failures else "needs_packet_inputs",
    }


def render_markdown(packet: dict[str, Any], limit: int) -> str:
    lines = [
        "# Blind Review Packet",
        "",
        str(packet.get("instructions") or ""),
        "",
        "This packet is read-only. Update accepted blind labels in `.ax/experiments/blind-session-section-label-review-e49.md` and accepted hard negatives in `.ax/experiments/blind-hard-negative-candidates-e54.md`.",
        "",
    ]
    for index, item in enumerate(packet.get("items", [])[:limit], start=1):
        risks = ", ".join(f"`{reason}`" for reason in item.get("risk_reasons", [])) or "_none_"
        evidence = ", ".join(f"`{ref}`" for ref in item.get("evidence_refs", [])) or "_none_"
        hard_negative = item.get("hard_negative_status") or "_none_"
        hard_negative_notes = str(item.get("hard_negative_review_notes") or "").strip() or "_pending_"
        proposed = (
            f"`{item.get('hard_negative_proposed_label')}` / `{item.get('hard_negative_proposed_target')}`"
            if item.get("hard_negative_status")
            else "_none_"
        )
        instruction = str(item.get("hard_negative_review_instruction") or "").strip() or "_none_"
        notes = str(item.get("review_notes") or "").strip() or "_pending_"
        lines.extend([
            f"## {index}. {item.get('id')}",
            "",
            f"- Priority score: `{item.get('priority_score')}`",
            f"- Risk reasons: {risks}",
            f"- Current label: `{item.get('label')}`",
            f"- Current target: `{item.get('target')}`",
            f"- Review notes: {notes}",
            f"- Suggested label: `{item.get('suggested_label')}`",
            f"- Suggested target: `{item.get('suggested_target')}`",
            f"- Confidence bucket: `{item.get('confidence_bucket')}`",
            f"- Binary confidence: `{item.get('binary_confidence')}`",
            f"- Family confidence: `{item.get('family_confidence')}`",
            f"- Hard-negative status: `{hard_negative}`",
            f"- Hard-negative notes: {hard_negative_notes}",
            f"- Hard-negative proposed label/target: {proposed}",
            f"- Hard-negative review instruction: {instruction}",
            f"- Hard-negative candidate id: `{item.get('hard_negative_candidate_id')}`",
            f"- Source window: `{item.get('source_window_id')}`",
            f"- Source turn: `{item.get('source_turn')}`",
            f"- Source session: `{item.get('source_session')}`",
            f"- Source seq: `{item.get('source_seq')}`",
            f"- Approx tokens: `{item.get('approx_tokens')}`",
            f"- Evidence: {evidence}",
            "",
            fenced_text(str(item.get("text") or "")),
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    packet = build_packet(
        load_json(args.review),
        load_json(args.suggestions),
        load_json(args.priorities),
        load_json(args.hard_negatives),
    )
    write_json(args.out, packet)
    brief = Path(args.brief)
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text(render_markdown(packet, args.limit))
    report = build_report(packet)
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind review packet report")
        print(f"items: {report['items']}")
        print(f"pending labels: {report['pending_labels']}")
        print(f"hard-negative candidates: {report['hard_negative_candidates']}")
        print(f"high priority: {report['high_priority_count']}")
        print(f"decision: {report['decision']}")
        print(f"out: {args.out}")
        print(f"brief: {args.brief}")
    return 0 if report["decision"] == "ready_for_consolidated_review" else 1


if __name__ == "__main__":
    raise SystemExit(main())
