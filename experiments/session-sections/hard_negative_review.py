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
from review_note_quality import note_present, note_substantive  # noqa: E402


VALID_STATUSES = {"pending_human_acceptance", "accepted", "rejected"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync and evaluate hard-negative candidate review statuses.")
    parser.add_argument("--candidates", default=".ax/experiments/blind-hard-negative-candidates-e54.json")
    parser.add_argument("--brief", default=".ax/experiments/blind-hard-negative-candidates-e54.md")
    parser.add_argument("--out", default=".ax/experiments/blind-hard-negative-review-e56-report.json")
    parser.add_argument("--mode", choices=["sync", "evaluate"], default="sync")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def strip_inline_code(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("`") and stripped.endswith("`") and len(stripped) >= 2:
        return stripped[1:-1].strip()
    return stripped


def parse_markdown_review(brief: str) -> dict[str, dict[str, str]]:
    updates: dict[str, dict[str, str]] = {}
    current_candidate_id: str | None = None
    for raw_line in brief.splitlines():
        line = raw_line.strip()
        candidate_match = re.match(r"^- Candidate id:\s*(.+)$", line)
        if candidate_match:
            current_candidate_id = strip_inline_code(candidate_match.group(1))
            updates.setdefault(current_candidate_id, {})
            continue
        if current_candidate_id is None:
            continue
        status_match = re.match(r"^- Status:\s*(.+)$", line)
        if status_match:
            updates[current_candidate_id]["status"] = strip_inline_code(status_match.group(1))
            continue
        notes_match = re.match(r"^- Review notes:\s*(.*)$", line)
        if notes_match:
            value = notes_match.group(1).strip()
            updates[current_candidate_id]["review_notes"] = "" if value == "_pending_" else value
    return updates


def sync_candidates_from_markdown(candidates: dict[str, Any], brief: str) -> dict[str, Any]:
    updates = parse_markdown_review(brief)
    synced = dict(candidates)
    items = []
    for item in candidates.get("items", []):
        next_item = dict(item)
        item_updates = updates.get(str(item.get("id")), {})
        if "status" in item_updates:
            next_item["status"] = item_updates["status"]
        if "review_notes" in item_updates:
            next_item["review_notes"] = item_updates["review_notes"]
        items.append(next_item)
    synced["items"] = items
    return synced


def evaluate_candidates(candidates: dict[str, Any]) -> dict[str, Any]:
    items = list(candidates.get("items", []))
    statuses = Counter(str(item.get("status") or "") for item in items)
    invalid = [
        str(item.get("id"))
        for item in items
        if str(item.get("status")) not in VALID_STATUSES
    ]
    reviewed_missing_notes = [
        str(item.get("id"))
        for item in items
        if str(item.get("status")) in {"accepted", "rejected"} and not note_present(str(item.get("review_notes") or ""))
    ]
    reviewed_invalid_notes = [
        str(item.get("id"))
        for item in items
        if (
            str(item.get("status")) in {"accepted", "rejected"}
            and note_present(str(item.get("review_notes") or ""))
            and not note_substantive(str(item.get("review_notes") or ""))
        )
    ]
    failures = []
    if invalid:
        failures.append("hard-negative review contains invalid statuses")
    if statuses.get("pending_human_acceptance", 0):
        failures.append("hard-negative review still has pending candidates")
    if reviewed_missing_notes:
        failures.append("reviewed hard-negative candidates are missing notes")
    if reviewed_invalid_notes:
        failures.append("reviewed hard-negative candidates have non-substantive notes")
    if not items:
        failures.append("hard-negative review has no candidates")
    return {
        "schema": "ax.hard_negative_review_report.v1",
        "candidates": len(items),
        "accepted": statuses.get("accepted", 0),
        "rejected": statuses.get("rejected", 0),
        "pending": statuses.get("pending_human_acceptance", 0),
        "statuses": dict(sorted(statuses.items())),
        "invalid_status_candidates": invalid,
        "reviewed_missing_notes": reviewed_missing_notes,
        "reviewed_invalid_notes": reviewed_invalid_notes,
        "failures": failures,
        "decision": "ready_for_hard_negative_export" if not failures else "needs_human_acceptance",
    }


def main() -> int:
    args = parse_args()
    candidates = load_json(args.candidates)
    if args.mode == "sync":
        candidates = sync_candidates_from_markdown(candidates, Path(args.brief).read_text())
        write_json(args.candidates, candidates)
    report = evaluate_candidates(candidates)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("hard-negative review report")
        print(f"candidates: {report['candidates']}")
        print(f"accepted: {report['accepted']}")
        print(f"rejected: {report['rejected']}")
        print(f"pending: {report['pending']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_for_hard_negative_export" else 1


if __name__ == "__main__":
    raise SystemExit(main())
