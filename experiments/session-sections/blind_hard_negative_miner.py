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


RISK_REASONS = {
    "environment_overprediction_risk",
    "context_dump",
    "possible_none_control_turn",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mine pending hard-negative candidates from prioritized blind review rows.")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--priorities", default=".ax/experiments/blind-session-section-review-priority-e52.json")
    parser.add_argument("--out", default=".ax/experiments/blind-hard-negative-candidates-e54.json")
    parser.add_argument("--brief", default=".ax/experiments/blind-hard-negative-candidates-e54.md")
    parser.add_argument("--report", default=".ax/experiments/blind-hard-negative-candidates-e54-report.json")
    parser.add_argument("--min-score", type=int, default=3)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(row.get("id")): row for row in rows}


def is_candidate(priority: dict[str, Any], min_score: int) -> bool:
    if str(priority.get("suggested_label")) != "environment_or_preference_signal":
        return False
    if int(priority.get("priority_score") or 0) < min_score:
        return False
    reasons = set(str(reason) for reason in priority.get("risk_reasons", []))
    return bool(reasons.intersection(RISK_REASONS))


def slug(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return normalized[:96] or "row"


def candidate_row(review_item: dict[str, Any], priority: dict[str, Any]) -> dict[str, Any]:
    source_id = str(review_item.get("id"))
    return {
        "id": f"pending-hard-negative/{source_id}",
        "source_blind_id": source_id,
        "source_window_id": review_item.get("source_window_id"),
        "status": "pending_human_acceptance",
        "proposed_label": "none",
        "proposed_target": "none",
        "original_suggested_label": priority.get("suggested_label"),
        "original_suggested_target": priority.get("suggested_target"),
        "priority_score": priority.get("priority_score"),
        "risk_reasons": list(priority.get("risk_reasons", [])),
        "text": str(review_item.get("text") or ""),
        "review_instruction": "Accept only if this row is ordinary control/context and should train the none boundary.",
    }


def mine_candidates(review: dict[str, Any], priorities: dict[str, Any], min_score: int) -> list[dict[str, Any]]:
    review_by_id = by_id(list(review.get("items", [])))
    rows = []
    for priority in priorities.get("items", []):
        if not is_candidate(priority, min_score):
            continue
        item = review_by_id.get(str(priority.get("id")))
        if item:
            rows.append(candidate_row(item, priority))
    return rows


def build_report(rows: list[dict[str, Any]], priorities: int, min_score: int) -> dict[str, Any]:
    reason_counts = Counter(
        reason
        for row in rows
        for reason in row.get("risk_reasons", [])
    )
    failures = []
    if priorities and not rows:
        failures.append("no hard-negative candidates mined")
    return {
        "schema": "ax.blind_hard_negative_candidates_report.v1",
        "priorities": priorities,
        "candidates": len(rows),
        "min_score": min_score,
        "risk_reason_counts": dict(sorted(reason_counts.items())),
        "statuses": dict(sorted(Counter(str(row.get("status")) for row in rows).items())),
        "failures": failures,
        "decision": "ready_for_human_acceptance" if not failures else "needs_review_signal",
    }


def excerpt(text: str, limit: int = 420) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3].rstrip() + "..."


def render_markdown(rows: list[dict[str, Any]]) -> str:
    lines = [
        "# Blind Hard-Negative Candidates",
        "",
        "These are not training fixtures yet. Accept a row only after human review confirms it should be a `none` hard negative.",
        "",
    ]
    for index, row in enumerate(rows, start=1):
        reasons = ", ".join(f"`{reason}`" for reason in row.get("risk_reasons", [])) or "_none_"
        lines.extend([
            f"## {index}. {row['source_blind_id']}",
            "",
            f"- Candidate id: `{row['id']}`",
            f"- Status: `{row['status']}`",
            f"- Proposed label: `{row['proposed_label']}`",
            f"- Proposed target: `{row['proposed_target']}`",
            f"- Original suggestion: `{row['original_suggested_label']}` / `{row['original_suggested_target']}`",
            f"- Priority score: `{row['priority_score']}`",
            f"- Risk reasons: {reasons}",
            f"- Source window: `{row.get('source_window_id')}`",
            "- Review notes: _pending_",
            "",
            f"> {excerpt(str(row.get('text') or ''))}",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    review = load_json(args.review)
    priorities = load_json(args.priorities)
    rows = mine_candidates(review, priorities, args.min_score)
    write_json(args.out, {"schema": "ax.blind_hard_negative_candidates.v1", "items": rows})
    brief = Path(args.brief)
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text(render_markdown(rows))
    report = build_report(rows, len(priorities.get("items", [])), args.min_score)
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind hard-negative candidates report")
        print(f"candidates: {report['candidates']}")
        print(f"risk reasons: {report['risk_reason_counts']}")
        print(f"decision: {report['decision']}")
        print(f"out: {args.out}")
        print(f"brief: {args.brief}")
    return 0 if report["decision"] == "ready_for_human_acceptance" else 1


if __name__ == "__main__":
    raise SystemExit(main())
