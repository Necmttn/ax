#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_fixture_pack import ALLOWED_LABELS, TARGET_HINTS  # noqa: E402
from blind_label_review import evaluate_review, load_json, write_json  # noqa: E402
from hard_negative_review import VALID_STATUSES, evaluate_candidates  # noqa: E402
from review_note_quality import note_present, note_substantive  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate, sync, or evaluate one editable blind review workspace.")
    parser.add_argument("--packet", default=".ax/experiments/blind-review-packet-e61.json")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--hard-negatives", default=".ax/experiments/blind-hard-negative-candidates-e54.json")
    parser.add_argument("--workspace", default=".ax/experiments/blind-review-workspace-e63.md")
    parser.add_argument("--label-report", default=".ax/experiments/blind-session-section-label-review-e49-report.json")
    parser.add_argument("--hard-negative-report", default=".ax/experiments/blind-hard-negative-review-e56-report.json")
    parser.add_argument("--out", default=".ax/experiments/blind-review-workspace-e63-report.json")
    parser.add_argument("--mode", choices=["generate", "sync", "evaluate"], default="generate")
    parser.add_argument("--dry-run", action="store_true", help="Validate and report sync results without writing E49/E54.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def strip_inline_code(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("`") and stripped.endswith("`") and len(stripped) >= 2:
        return stripped[1:-1].strip()
    return stripped


def fenced_text(value: str) -> str:
    return f"```text\n{value.rstrip()}\n```"


def render_workspace(packet: dict[str, Any]) -> str:
    lines = [
        "# Blind Review Workspace",
        "",
        "Edit the `Review label`, `Review target`, `Review notes`, `Hard-negative status`, and `Hard-negative notes` fields here, then sync this file back to E49 and E54.",
        "",
        "Allowed labels:",
        "",
    ]
    lines.extend(f"- `{label}`" for label in ALLOWED_LABELS)
    lines.extend([
        "",
        "Target hints:",
        "",
    ])
    lines.extend(f"- `{target}`" for target in TARGET_HINTS)
    lines.extend([
        "",
        "Hard-negative statuses:",
        "",
    ])
    lines.extend(f"- `{status}`" for status in sorted(VALID_STATUSES))
    lines.append("")
    for index, item in enumerate(packet.get("items", []), start=1):
        risks = ", ".join(f"`{reason}`" for reason in item.get("risk_reasons", [])) or "_none_"
        hard_negative_candidate_id = item.get("hard_negative_candidate_id") or "_none_"
        hard_negative_status = item.get("hard_negative_status") or "_none_"
        hard_negative_notes = item.get("hard_negative_review_notes") or "_pending_"
        hard_negative_proposed = (
            f"`{item.get('hard_negative_proposed_label')}` / `{item.get('hard_negative_proposed_target')}`"
            if item.get("hard_negative_status")
            else "_none_"
        )
        hard_negative_instruction = str(item.get("hard_negative_review_instruction") or "").strip() or "_none_"
        evidence = ", ".join(f"`{ref}`" for ref in item.get("evidence_refs", [])) or "_none_"
        lines.extend([
            f"## {index}. {item.get('id')}",
            "",
            f"- Review label: `{item.get('label')}`",
            f"- Review target: `{item.get('target')}`",
            f"- Review notes: {str(item.get('review_notes') or '').strip() or '_pending_'}",
            f"- Hard-negative candidate id: `{hard_negative_candidate_id}`",
            f"- Hard-negative status: `{hard_negative_status}`",
            f"- Hard-negative notes: {hard_negative_notes}",
            f"- Hard-negative proposed label/target: {hard_negative_proposed}",
            f"- Hard-negative review instruction: {hard_negative_instruction}",
            f"- Suggested label: `{item.get('suggested_label')}`",
            f"- Suggested target: `{item.get('suggested_target')}`",
            f"- Confidence bucket: `{item.get('confidence_bucket')}`",
            f"- Binary confidence: `{item.get('binary_confidence')}`",
            f"- Family confidence: `{item.get('family_confidence')}`",
            f"- Priority score: `{item.get('priority_score')}`",
            f"- Risk reasons: {risks}",
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


def parse_workspace(markdown: str) -> dict[str, dict[str, str]]:
    updates: dict[str, dict[str, str]] = {}
    current_id: str | None = None
    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        heading = re.match(r"^##\s+(?:\d+\.\s+)?(.+)$", line)
        if heading:
            current_id = heading.group(1).strip()
            updates.setdefault(current_id, {})
            continue
        if current_id is None:
            continue
        for field, key in (
            ("Review label", "label"),
            ("Review target", "target"),
            ("Review notes", "review_notes"),
            ("Hard-negative candidate id", "hard_negative_candidate_id"),
            ("Hard-negative status", "hard_negative_status"),
            ("Hard-negative notes", "hard_negative_review_notes"),
        ):
            match = re.match(rf"^- {re.escape(field)}:\s*(.*)$", line)
            if match:
                value = strip_inline_code(match.group(1))
                updates[current_id][key] = "" if value == "_pending_" else value
                break
    return updates


def sync_review(review: dict[str, Any], updates: dict[str, dict[str, str]]) -> dict[str, Any]:
    synced = dict(review)
    items = []
    for item in review.get("items", []):
        next_item = dict(item)
        item_updates = updates.get(str(item.get("id")), {})
        for source, target in (("label", "label"), ("target", "target"), ("review_notes", "review_notes")):
            if source in item_updates:
                next_item[target] = item_updates[source]
        items.append(next_item)
    synced["items"] = items
    return synced


def sync_hard_negatives(candidates: dict[str, Any], updates: dict[str, dict[str, str]]) -> dict[str, Any]:
    updates_by_candidate_id = {
        str(update.get("hard_negative_candidate_id")): update
        for update in updates.values()
        if update.get("hard_negative_candidate_id") and update.get("hard_negative_candidate_id") != "_none_"
    }
    synced = dict(candidates)
    items = []
    for item in candidates.get("items", []):
        next_item = dict(item)
        item_updates = updates_by_candidate_id.get(str(item.get("id")), {})
        if "hard_negative_status" in item_updates and item_updates["hard_negative_status"] != "_none_":
            next_item["status"] = item_updates["hard_negative_status"]
        if "hard_negative_review_notes" in item_updates:
            next_item["review_notes"] = item_updates["hard_negative_review_notes"]
        items.append(next_item)
    synced["items"] = items
    return synced


def validate_workspace_updates(
    updates: dict[str, dict[str, str]],
    review: dict[str, Any],
    candidates: dict[str, Any],
) -> list[str]:
    failures: list[str] = []
    review_ids = {str(item.get("id")) for item in review.get("items", [])}
    candidate_ids = {str(item.get("id")) for item in candidates.get("items", [])}
    allowed_labels = set(ALLOWED_LABELS).union({"__pending__"})
    allowed_targets = set(TARGET_HINTS).union({"__pending__"})
    allowed_statuses = set(VALID_STATUSES).union({"_none_", ""})
    for row_id, update in updates.items():
        if row_id not in review_ids:
            failures.append(f"workspace row does not match review item: {row_id}")
        label = update.get("label")
        if label is not None and label not in allowed_labels:
            failures.append(f"invalid review label for {row_id}: {label}")
        target = update.get("target")
        if target is not None and target not in allowed_targets:
            failures.append(f"invalid review target for {row_id}: {target}")
        review_notes = update.get("review_notes")
        if label and label != "__pending__":
            if not note_present(review_notes):
                failures.append(f"missing review notes for {row_id}")
            elif not note_substantive(review_notes):
                failures.append(f"non-substantive review notes for {row_id}")
        candidate_id = update.get("hard_negative_candidate_id")
        if candidate_id and candidate_id != "_none_" and candidate_id not in candidate_ids:
            failures.append(f"unknown hard-negative candidate id for {row_id}: {candidate_id}")
        status = update.get("hard_negative_status")
        if status is not None and status not in allowed_statuses:
            failures.append(f"invalid hard-negative status for {row_id}: {status}")
        hard_negative_notes = update.get("hard_negative_review_notes")
        if status in {"accepted", "rejected"}:
            if not note_present(hard_negative_notes):
                failures.append(f"missing hard-negative notes for {row_id}: {candidate_id}")
            elif not note_substantive(hard_negative_notes):
                failures.append(f"non-substantive hard-negative notes for {row_id}: {candidate_id}")
    return failures


def build_report(
    review_report: dict[str, Any],
    hard_negative_report: dict[str, Any],
    update_failures: list[str] | None = None,
    progress: dict[str, Any] | None = None,
) -> dict[str, Any]:
    review_ready = review_report.get("decision") == "ready_for_blind_gate_eval"
    hard_ready = hard_negative_report.get("decision") == "ready_for_hard_negative_export"
    update_failures = update_failures or []
    failures = list(update_failures)
    if not review_ready:
        failures.append("blind label review is not ready")
    if not hard_ready:
        failures.append("hard-negative review is not ready")
    return {
        "schema": "ax.blind_review_workspace_report.v1",
        "review_mode": "assisted_consolidated_workspace",
        "blind_label_decision": review_report.get("decision"),
        "blind_label_pending": review_report.get("pending"),
        "hard_negative_decision": hard_negative_report.get("decision"),
        "hard_negative_pending": hard_negative_report.get("pending"),
        "hard_negative_accepted": hard_negative_report.get("accepted"),
        "progress": progress or {},
        "workspace_update_failures": update_failures,
        "failures": failures,
        "decision": (
            "needs_workspace_fix"
            if update_failures
            else "ready_for_roundtrip"
            if not failures
            else "needs_human_review"
        ),
    }


def workspace_progress(review: dict[str, Any], candidates: dict[str, Any], limit: int = 10) -> dict[str, Any]:
    review_items = list(review.get("items", []))
    pending_review_refs = [
        {
            "ordinal": index,
            "id": str(item.get("id")),
        }
        for index, item in enumerate(review_items, start=1)
        if str(item.get("label")) == "__pending__" or str(item.get("target")) == "__pending__"
    ]
    hard_negative_items = list(candidates.get("items", []))
    pending_hard_negative_refs = [
        {
            "ordinal": index,
            "id": str(item.get("id")),
            "source_blind_id": str(item.get("source_blind_id") or ""),
        }
        for index, item in enumerate(hard_negative_items, start=1)
        if str(item.get("status")) == "pending_human_acceptance"
    ]
    hard_negative_reviewed = [
        item
        for item in hard_negative_items
        if str(item.get("status")) in {"accepted", "rejected"}
    ]
    return {
        "review_items": len(review_items),
        "blind_label_reviewed": len(review_items) - len(pending_review_refs),
        "blind_label_pending": len(pending_review_refs),
        "blind_label_next_pending_ids": [ref["id"] for ref in pending_review_refs[:limit]],
        "blind_label_next_pending_refs": pending_review_refs[:limit],
        "hard_negative_candidates": len(hard_negative_items),
        "hard_negative_reviewed": len(hard_negative_reviewed),
        "hard_negative_pending": len(pending_hard_negative_refs),
        "hard_negative_next_pending_ids": [ref["id"] for ref in pending_hard_negative_refs[:limit]],
        "hard_negative_next_pending_refs": pending_hard_negative_refs[:limit],
    }


def main() -> int:
    args = parse_args()
    if args.mode == "generate":
        workspace = Path(args.workspace)
        workspace.parent.mkdir(parents=True, exist_ok=True)
        workspace.write_text(render_workspace(load_json(args.packet)))

    review = load_json(args.review)
    hard_negatives = load_json(args.hard_negatives)
    update_failures: list[str] = []
    if args.mode == "sync":
        updates = parse_workspace(Path(args.workspace).read_text())
        update_failures = validate_workspace_updates(updates, review, hard_negatives)
        if not update_failures:
            review = sync_review(review, updates)
            hard_negatives = sync_hard_negatives(hard_negatives, updates)
            if not args.dry_run:
                write_json(args.review, review)
                write_json(args.hard_negatives, hard_negatives)

    review_report = evaluate_review(review)
    hard_negative_report = evaluate_candidates(hard_negatives)
    if not args.dry_run:
        write_json(args.label_report, review_report)
        write_json(args.hard_negative_report, hard_negative_report)
    report = build_report(review_report, hard_negative_report, update_failures, workspace_progress(review, hard_negatives))
    report["dry_run"] = bool(args.dry_run)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind review workspace report")
        print(f"decision: {report['decision']}")
        print(f"blind label pending: {report['blind_label_pending']}")
        print(f"hard-negative pending: {report['hard_negative_pending']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_for_roundtrip" else 1


if __name__ == "__main__":
    raise SystemExit(main())
