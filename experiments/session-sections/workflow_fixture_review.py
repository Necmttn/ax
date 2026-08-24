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

from blind_label_review import write_json, write_jsonl  # noqa: E402
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate, sync, or evaluate workflow-candidate fixture review packs.")
    parser.add_argument("--fixtures", default=".ax/experiments/workflow-topic-surrealml-classifier-fixtures-e183.jsonl")
    parser.add_argument("--review", default=".ax/experiments/workflow-fixture-review-e184.json")
    parser.add_argument("--brief", default=".ax/experiments/workflow-fixture-review-e184.md")
    parser.add_argument("--accepted-out", default=".ax/experiments/workflow-fixtures-accepted-e184.jsonl")
    parser.add_argument("--out", default=".ax/experiments/workflow-fixture-review-e184-report.json")
    parser.add_argument("--mode", choices=["generate", "sync", "evaluate"], default="generate")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def generate_review(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": "ax.workflow_fixture_review.v1",
        "instructions": "Accept only rows that should become classifier fixtures. Reject duplicates, wrong labels, private text, or weak evidence.",
        "valid_statuses": sorted(VALID_STATUSES),
        "valid_labels": sorted(VALID_LABELS),
        "items": [
            {
                "id": str(row.get("id")),
                "status": str(row.get("review_status") or "pending"),
                "label": str(row.get("label") or ""),
                "target": str(row.get("target") or ""),
                "review_notes": str(row.get("review_notes") or ""),
                "candidate_id": str(row.get("candidate_id") or ""),
                "candidate_label": str(row.get("candidate_label") or ""),
                "topic": str(row.get("topic") or ""),
                "result_id": row.get("result_id"),
                "turn": row.get("turn"),
                "confidence": row.get("confidence"),
                "text": str(row.get("text") or ""),
            }
            for row in rows
        ],
    }


def fenced_text(value: str) -> str:
    return f"```text\n{value.rstrip()}\n```"


def render_markdown_brief(review: dict[str, Any]) -> str:
    lines = [
        "# Workflow Fixture Review",
        "",
        str(review.get("instructions") or ""),
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
            f"- Label: `{item.get('label')}`",
            f"- Target: `{item.get('target')}`",
            f"- Review notes: {notes}",
            f"- Topic: `{item.get('topic')}`",
            f"- Candidate: `{item.get('candidate_label')}`",
            f"- Candidate id: `{item.get('candidate_id')}`",
            f"- Result: `{item.get('result_id')}`",
            f"- Turn: `{item.get('turn')}`",
            f"- Confidence: `{item.get('confidence')}`",
            "",
            fenced_text(str(item.get("text") or "")),
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def strip_inline_code(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("`") and stripped.endswith("`") and len(stripped) >= 2:
        return stripped[1:-1].strip()
    return stripped


def parse_markdown_review(brief: str) -> dict[str, dict[str, str]]:
    updates: dict[str, dict[str, str]] = {}
    current_id: str | None = None
    for raw_line in brief.splitlines():
        line = raw_line.strip()
        heading = re.match(r"^##\s+(?:\d+\.\s+)?(.+)$", line)
        if heading:
            current_id = heading.group(1).strip()
            updates.setdefault(current_id, {})
            continue
        if current_id is None:
            continue
        for key, label in (("status", "Status"), ("review_notes", "Review notes"), ("label", "Label"), ("target", "Target")):
            match = re.match(rf"^- {label}:\s*(.*)$", line)
            if match:
                value = match.group(1).strip()
                updates[current_id][key] = "" if value == "_pending_" else strip_inline_code(value)
                break
    return updates


def sync_review_from_markdown(review: dict[str, Any], brief: str) -> dict[str, Any]:
    updates = parse_markdown_review(brief)
    synced = dict(review)
    items = []
    for item in review.get("items", []):
        item_id = str(item.get("id"))
        next_item = dict(item)
        for key, value in updates.get(item_id, {}).items():
            next_item[key] = value
        items.append(next_item)
    synced["items"] = items
    return synced


def review_items_by_id(review: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item.get("id")): item for item in review.get("items", [])}


def apply_review_to_fixtures(rows: list[dict[str, Any]], review: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = review_items_by_id(review)
    accepted = []
    for row in rows:
        item = by_id.get(str(row.get("id")))
        if item is None or str(item.get("status")) != "accepted":
            continue
        next_row = dict(row)
        next_row["review_status"] = "accepted"
        next_row["label"] = str(item.get("label") or row.get("label") or "")
        next_row["target"] = str(item.get("target") or row.get("target") or "")
        next_row["review_notes"] = str(item.get("review_notes") or "")
        accepted.append(next_row)
    return accepted


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
        if str(item.get("label") or "") not in VALID_LABELS
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
    failures = []
    if not items:
        failures.append("workflow fixture review has no items")
    if statuses.get("pending", 0):
        failures.append("workflow fixture review still has pending items")
    if invalid_statuses:
        failures.append("workflow fixture review contains invalid statuses")
    if invalid_labels:
        failures.append("workflow fixture review contains invalid labels")
    if missing_notes:
        failures.append("reviewed workflow fixtures are missing notes")
    if invalid_notes:
        failures.append("reviewed workflow fixtures have non-substantive notes")
    return {
        "schema": "ax.workflow_fixture_review_report.v1",
        "items": len(items),
        "accepted": statuses.get("accepted", 0),
        "rejected": statuses.get("rejected", 0),
        "pending": statuses.get("pending", 0),
        "statuses": dict(sorted(statuses.items())),
        "invalid_status_items": invalid_statuses,
        "invalid_label_items": invalid_labels,
        "reviewed_missing_notes": missing_notes,
        "reviewed_invalid_notes": invalid_notes,
        "failures": failures,
        "decision": "ready_to_append_workflow_fixtures" if not failures else "needs_workflow_fixture_review",
    }


def main() -> int:
    args = parse_args()
    rows = load_jsonl(args.fixtures)
    if args.mode == "generate":
        review = generate_review(rows)
        write_json(args.review, review)
        Path(args.brief).parent.mkdir(parents=True, exist_ok=True)
        Path(args.brief).write_text(render_markdown_brief(review))
    elif args.mode == "sync":
        review = sync_review_from_markdown(load_json(args.review), Path(args.brief).read_text())
        write_json(args.review, review)
    else:
        review = load_json(args.review)
    accepted = apply_review_to_fixtures(rows, review)
    write_jsonl(args.accepted_out, accepted)
    report = evaluate_review(review)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("workflow fixture review report")
        print(f"items: {report['items']}")
        print(f"accepted: {report['accepted']}")
        print(f"rejected: {report['rejected']}")
        print(f"pending: {report['pending']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"review: {args.review}")
        if args.mode == "generate":
            print(f"brief: {args.brief}")
        if args.mode == "sync":
            print(f"synced from: {args.brief}")
        print(f"accepted out: {args.accepted_out}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_to_append_workflow_fixtures" else 1


if __name__ == "__main__":
    raise SystemExit(main())
