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

from blind_fixture_pack import ALLOWED_LABELS, TARGET_HINTS  # noqa: E402
from review_note_quality import note_present, note_substantive  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate, sync, or evaluate blind fixture labels without exposing model predictions.")
    parser.add_argument("--fixtures", default=".ax/experiments/blind-session-section-fixtures-e46.jsonl")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--brief", default=".ax/experiments/blind-session-section-label-review-e49.md")
    parser.add_argument("--labeled-out", default=".ax/experiments/blind-session-section-fixtures-e49-labeled.jsonl")
    parser.add_argument("--out", default=".ax/experiments/blind-session-section-label-review-e49-report.json")
    parser.add_argument("--mode", choices=["generate", "sync", "evaluate"], default="generate")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def write_json(path: str, value: dict[str, Any]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(value, indent=2) + "\n")


def evidence_refs(row: dict[str, Any]) -> list[str]:
    refs: list[str] = []
    for item in row.get("evidence") or []:
        if isinstance(item, dict):
            ref = item.get("ref")
        else:
            ref = item
        if ref:
            refs.append(str(ref))
    return refs


def generate_review(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": "ax.blind_session_section_label_review.v1",
        "instructions": "Assign label, target, and review_notes from the text only. Do not consult model predictions while labeling.",
        "allowed_labels": ALLOWED_LABELS,
        "target_hints": TARGET_HINTS,
        "items": [
            {
                "id": str(row.get("id")),
                "source_window_id": str(row.get("source_window_id") or ""),
                "source_turn": row.get("source_turn"),
                "source_session": row.get("source_session"),
                "source_seq": row.get("source_seq"),
                "approx_tokens": int(row.get("approx_tokens") or 0),
                "evidence_refs": evidence_refs(row),
                "label": str(row.get("label") or "__pending__"),
                "target": str(row.get("target") or "__pending__"),
                "review_notes": str(row.get("review_notes") or ""),
                "text": str(row.get("text") or ""),
            }
            for row in rows
        ],
    }


def fenced_text(value: str) -> str:
    return f"```text\n{value.rstrip()}\n```"


def render_markdown_brief(review: dict[str, Any]) -> str:
    lines = [
        "# Blind Session-Section Label Review",
        "",
        str(review.get("instructions") or ""),
        "",
        "Allowed labels:",
        "",
    ]
    lines.extend(f"- `{label}`" for label in review.get("allowed_labels", ALLOWED_LABELS))
    lines.extend([
        "",
        "Target hints:",
        "",
    ])
    lines.extend(f"- `{target}`" for target in review.get("target_hints", TARGET_HINTS))
    lines.append("")
    for index, item in enumerate(review.get("items", []), start=1):
        evidence = ", ".join(f"`{ref}`" for ref in item.get("evidence_refs", [])) or "_none_"
        notes = str(item.get("review_notes") or "").strip() or "_pending_"
        lines.extend([
            f"## {index}. {item.get('id')}",
            "",
            f"- Source window: `{item.get('source_window_id')}`",
            f"- Source turn: `{item.get('source_turn')}`",
            f"- Source session: `{item.get('source_session')}`",
            f"- Source seq: `{item.get('source_seq')}`",
            f"- Approx tokens: `{item.get('approx_tokens')}`",
            f"- Evidence: {evidence}",
            f"- Label: `{item.get('label')}`",
            f"- Target: `{item.get('target')}`",
            f"- Review notes: {notes}",
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
        label = re.match(r"^- Label:\s*(.+)$", line)
        if label:
            updates[current_id]["label"] = strip_inline_code(label.group(1))
            continue
        target = re.match(r"^- Target:\s*(.+)$", line)
        if target:
            updates[current_id]["target"] = strip_inline_code(target.group(1))
            continue
        notes = re.match(r"^- Review notes:\s*(.*)$", line)
        if notes:
            value = notes.group(1).strip()
            updates[current_id]["review_notes"] = "" if value == "_pending_" else value
    return updates


def sync_review_from_markdown(review: dict[str, Any], brief: str) -> dict[str, Any]:
    updates = parse_markdown_review(brief)
    synced = dict(review)
    items = []
    for item in review.get("items", []):
        item_id = str(item.get("id"))
        next_item = dict(item)
        item_updates = updates.get(item_id, {})
        for key in ("label", "target", "review_notes"):
            if key in item_updates:
                next_item[key] = item_updates[key]
        items.append(next_item)
    synced["items"] = items
    return synced


def review_items_by_id(review: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item.get("id")): item for item in review.get("items", [])}


def apply_review_to_fixtures(rows: list[dict[str, Any]], review: dict[str, Any]) -> list[dict[str, Any]]:
    by_id = review_items_by_id(review)
    labeled = []
    for row in rows:
        next_row = dict(row)
        item = by_id.get(str(row.get("id")))
        if item:
            next_row["label"] = str(item.get("label") or "__pending__")
            next_row["target"] = str(item.get("target") or "__pending__")
            next_row["review_notes"] = str(item.get("review_notes") or "")
        labeled.append(next_row)
    return labeled


def evaluate_review(review: dict[str, Any]) -> dict[str, Any]:
    items = list(review.get("items") or [])
    label_counts = Counter(str(item.get("label") or "") for item in items)
    pending = [
        str(item.get("id"))
        for item in items
        if str(item.get("label")) == "__pending__" or str(item.get("target")) == "__pending__"
    ]
    invalid_labels = [
        str(item.get("id"))
        for item in items
        if str(item.get("label")) not in set(ALLOWED_LABELS) and str(item.get("label")) != "__pending__"
    ]
    missing_notes = [
        str(item.get("id"))
        for item in items
        if str(item.get("label")) != "__pending__" and not note_present(str(item.get("review_notes") or ""))
    ]
    invalid_notes = [
        str(item.get("id"))
        for item in items
        if (
            str(item.get("label")) != "__pending__"
            and note_present(str(item.get("review_notes") or ""))
            and not note_substantive(str(item.get("review_notes") or ""))
        )
    ]
    failures = []
    if not items:
        failures.append("review has no blind label items")
    if pending:
        failures.append("review still has pending blind labels")
    if invalid_labels:
        failures.append("review contains invalid blind labels")
    if missing_notes:
        failures.append("reviewed blind labels are missing review notes")
    if invalid_notes:
        failures.append("reviewed blind labels have non-substantive review notes")
    return {
        "schema": "ax.blind_session_section_label_review_report.v1",
        "items": len(items),
        "pending": len(pending),
        "label_counts": dict(sorted(label_counts.items())),
        "invalid_labels": invalid_labels,
        "reviewed_labels_missing_notes": missing_notes,
        "reviewed_labels_invalid_notes": invalid_notes,
        "failures": failures,
        "decision": "ready_for_blind_gate_eval" if not failures else "needs_blind_label_review",
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

    labeled_rows = apply_review_to_fixtures(rows, review)
    write_jsonl(args.labeled_out, labeled_rows)
    report = evaluate_review(review)
    write_json(args.out, report)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind label review report")
        print(f"items: {report['items']}")
        print(f"pending: {report['pending']}")
        print(f"label counts: {report['label_counts']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"review: {args.review}")
        if args.mode == "generate":
            print(f"brief: {args.brief}")
        if args.mode == "sync":
            print(f"synced from: {args.brief}")
        print(f"labeled out: {args.labeled_out}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_for_blind_gate_eval" else 1


if __name__ == "__main__":
    raise SystemExit(main())
