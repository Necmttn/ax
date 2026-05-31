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

from blind_label_review import write_json  # noqa: E402
from review_note_quality import note_present, note_substantive  # noqa: E402


VALID_STATUSES = {"pending", "accepted", "rejected"}
VALID_LABELS = {
    "approval",
    "correction",
    "direction",
    "none",
    "recovery_action",
    "rejection",
    "tooling_or_environment_issue",
    "verification_request",
}
DEFAULT_SOURCE_GROUP = "session-section-chunks"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Review repeated residual boundary misses before fixture promotion.")
    parser.add_argument("--analysis", default=".ax/experiments/setfit-failure-analysis-embedding-helper-fixtures-current.json")
    parser.add_argument("--review", default=".ax/experiments/boundary-miss-review-current.json")
    parser.add_argument("--brief", default=".ax/experiments/boundary-miss-review-current.md")
    parser.add_argument("--out", default=".ax/experiments/boundary-miss-review-current-report.json")
    parser.add_argument("--mode", choices=["generate", "sync", "evaluate"], default="generate")
    parser.add_argument("--min-hit-count", type=int, default=2)
    parser.add_argument("--source-group", default=DEFAULT_SOURCE_GROUP)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def strip_inline_code(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("`") and stripped.endswith("`") and len(stripped) >= 2:
        return stripped[1:-1].strip()
    return stripped


def selected_misses(analysis: dict[str, Any], min_hit_count: int, source_group: str) -> list[dict[str, Any]]:
    rows = []
    for miss in analysis.get("all_seed_repeated_misses") or []:
        if int(miss.get("hit_count") or 0) < min_hit_count:
            continue
        if source_group and str(miss.get("source_group") or "") != source_group:
            continue
        rows.append(miss)
    return rows


def generate_review(analysis: dict[str, Any], min_hit_count: int = 2, source_group: str = DEFAULT_SOURCE_GROUP) -> dict[str, Any]:
    misses = selected_misses(analysis, min_hit_count, source_group)
    return {
        "schema": "ax.boundary_miss_review.v1",
        "instructions": (
            "Accept only residual misses whose current canonical fixture label should remain unchanged. "
            "Reject rows that need relabeling, target changes, text changes, or label-contract edits before fixture promotion."
        ),
        "source_analysis_decision": analysis.get("decision"),
        "source_gate": analysis.get("gate"),
        "min_hit_count": min_hit_count,
        "source_group": source_group,
        "valid_statuses": sorted(VALID_STATUSES),
        "valid_labels": sorted(VALID_LABELS),
        "items": [
            {
                "id": str(miss.get("id")),
                "status": "pending",
                "review_label": str(miss.get("fine_label") or ""),
                "review_action": "keep_existing_label",
                "review_notes": "",
                "actual": str(miss.get("actual") or ""),
                "predicted_labels": list(miss.get("predicted_labels") or []),
                "families": list(miss.get("families") or []),
                "seeds": list(miss.get("seeds") or []),
                "hit_count": int(miss.get("hit_count") or 0),
                "max_confidence": miss.get("max_confidence"),
                "current_label": miss.get("fine_label"),
                "target": miss.get("target"),
                "source_group": miss.get("source_group"),
                "boundary_group": miss.get("boundary_group"),
                "pair_group": miss.get("pair_group"),
                "text_excerpt": miss.get("text_excerpt"),
            }
            for miss in misses
        ],
    }


def fenced_text(value: str) -> str:
    return f"```text\n{str(value).rstrip()}\n```"


def render_markdown_brief(review: dict[str, Any]) -> str:
    lines = [
        "# Boundary Miss Review",
        "",
        str(review.get("instructions") or ""),
        "",
        f"Source analysis decision: `{review.get('source_analysis_decision')}`",
        f"Minimum hit count: `{review.get('min_hit_count')}`",
        f"Source group: `{review.get('source_group')}`",
        "",
        "Valid statuses:",
        "",
    ]
    lines.extend(f"- `{status}`" for status in review.get("valid_statuses", sorted(VALID_STATUSES)))
    lines.extend(["", "Valid labels:", ""])
    lines.extend(f"- `{label}`" for label in review.get("valid_labels", sorted(VALID_LABELS)))
    lines.append("")
    for index, item in enumerate(review.get("items", []), start=1):
        notes = str(item.get("review_notes") or "").strip() or "_pending_"
        lines.extend([
            f"## {index}. {item.get('id')}",
            "",
            f"- Status: `{item.get('status')}`",
            f"- Review label: `{item.get('review_label')}`",
            f"- Review action: `{item.get('review_action')}`",
            f"- Review notes: {notes}",
            f"- Actual coarse: `{item.get('actual')}`",
            f"- Predicted coarse: `{', '.join(item.get('predicted_labels') or [])}`",
            f"- Families: `{', '.join(item.get('families') or [])}`",
            f"- Seeds: `{', '.join(str(seed) for seed in item.get('seeds') or [])}`",
            f"- Hit count: `{item.get('hit_count')}`",
            f"- Max confidence: `{item.get('max_confidence')}`",
            f"- Current label: `{item.get('current_label')}`",
            f"- Target: `{item.get('target')}`",
            f"- Boundary group: `{item.get('boundary_group')}`",
            f"- Pair group: `{item.get('pair_group')}`",
            "",
            fenced_text(str(item.get("text_excerpt") or "")),
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def parse_markdown_review(brief: str) -> dict[str, dict[str, str]]:
    updates: dict[str, dict[str, str]] = {}
    current_id: str | None = None
    fields = (
        ("status", "Status"),
        ("review_label", "Review label"),
        ("review_action", "Review action"),
        ("review_notes", "Review notes"),
    )
    for raw_line in brief.splitlines():
        line = raw_line.strip()
        heading = re.match(r"^##\s+(?:\d+\.\s+)?(.+)$", line)
        if heading:
            current_id = heading.group(1).strip()
            updates.setdefault(current_id, {})
            continue
        if current_id is None:
            continue
        for key, label in fields:
            match = re.match(rf"^- {label}:\s*(.*)$", line)
            if match:
                value = match.group(1).strip()
                updates[current_id][key] = "" if value == "_pending_" else strip_inline_code(value)
                break
    return updates


def sync_review_from_markdown(review: dict[str, Any], brief: str) -> dict[str, Any]:
    updates = parse_markdown_review(brief)
    synced = dict(review)
    synced["items"] = [
        {**item, **updates.get(str(item.get("id")), {})}
        for item in review.get("items", [])
    ]
    return synced


def evaluate_review(review: dict[str, Any]) -> dict[str, Any]:
    items = list(review.get("items") or [])
    statuses = Counter(str(item.get("status") or "") for item in items)
    invalid_statuses = [
        str(item.get("id"))
        for item in items
        if str(item.get("status") or "") not in VALID_STATUSES
    ]
    invalid_labels = [
        str(item.get("id"))
        for item in items
        if str(item.get("review_label") or "") not in VALID_LABELS
    ]
    missing_notes = [
        str(item.get("id"))
        for item in items
        if str(item.get("status")) in {"accepted", "rejected"} and not note_present(str(item.get("review_notes") or ""))
    ]
    invalid_notes = [
        str(item.get("id"))
        for item in items
        if (
            str(item.get("status")) in {"accepted", "rejected"}
            and note_present(str(item.get("review_notes") or ""))
            and not note_substantive(str(item.get("review_notes") or ""))
        )
    ]
    accepted_label_changes = [
        str(item.get("id"))
        for item in items
        if str(item.get("status")) == "accepted" and str(item.get("review_label") or "") != str(item.get("current_label") or "")
    ]
    failures = []
    if not items:
        failures.append("boundary miss review has no items")
    if statuses.get("pending", 0):
        failures.append("boundary miss review still has pending items")
    if invalid_statuses:
        failures.append("boundary miss review contains invalid statuses")
    if invalid_labels:
        failures.append("boundary miss review contains invalid labels")
    if missing_notes:
        failures.append("reviewed boundary misses are missing notes")
    if invalid_notes:
        failures.append("reviewed boundary misses have non-substantive notes")
    if accepted_label_changes:
        failures.append("accepted boundary misses cannot change labels")

    rejected = statuses.get("rejected", 0)
    if failures:
        decision = "needs_boundary_miss_review"
    elif rejected:
        decision = "boundary_review_requires_fixture_changes"
    else:
        decision = "boundary_review_ready_for_fixture_promotion"
    return {
        "schema": "ax.boundary_miss_review_report.v1",
        "items": len(items),
        "accepted": statuses.get("accepted", 0),
        "rejected": rejected,
        "pending": statuses.get("pending", 0),
        "statuses": dict(sorted(statuses.items())),
        "family_counts": dict(sorted(Counter(family for item in items for family in item.get("families", [])).items())),
        "actual_counts": dict(sorted(Counter(str(item.get("actual") or "") for item in items).items())),
        "invalid_status_items": invalid_statuses,
        "invalid_label_items": invalid_labels,
        "reviewed_missing_notes": missing_notes,
        "reviewed_invalid_notes": invalid_notes,
        "accepted_label_change_items": accepted_label_changes,
        "promotion_ready": not failures and rejected == 0,
        "failures": failures,
        "decision": decision,
    }


def main() -> int:
    args = parse_args()
    if args.mode == "generate":
        review = generate_review(load_json(args.analysis), args.min_hit_count, args.source_group)
        write_json(args.review, review)
        Path(args.brief).parent.mkdir(parents=True, exist_ok=True)
        Path(args.brief).write_text(render_markdown_brief(review))
    elif args.mode == "sync":
        review = sync_review_from_markdown(load_json(args.review), Path(args.brief).read_text())
        write_json(args.review, review)
    else:
        review = load_json(args.review)
    report = evaluate_review(review)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("boundary miss review report")
        print(f"items: {report['items']}")
        print(f"accepted: {report['accepted']}")
        print(f"rejected: {report['rejected']}")
        print(f"pending: {report['pending']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
    return 0 if not report["failures"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
