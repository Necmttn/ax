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


HARD_NEGATIVE_STATUSES = {"pending_human_acceptance", "accepted", "rejected"}
DEDUPE_STATUSES = {"pending_review", "accepted", "rejected"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sync and evaluate embedding helper review statuses.")
    parser.add_argument("--review", default=".ax/experiments/embedding-helper-review-current.json")
    parser.add_argument("--brief", default=".ax/experiments/embedding-helper-review-current.md")
    parser.add_argument("--out", default=".ax/experiments/embedding-helper-review-status-current.json")
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
    current_id: str | None = None
    for raw_line in brief.splitlines():
        line = raw_line.strip()
        id_match = re.match(r"^- (?:Candidate id|Cluster id):\s*(.+)$", line)
        if id_match:
            current_id = strip_inline_code(id_match.group(1))
            updates.setdefault(current_id, {})
            continue
        if current_id is None:
            continue
        status_match = re.match(r"^- Status:\s*(.+)$", line)
        if status_match:
            updates[current_id]["status"] = strip_inline_code(status_match.group(1))
            continue
        notes_match = re.match(r"^- Review notes:\s*(.*)$", line)
        if notes_match:
            value = notes_match.group(1).strip()
            updates[current_id]["review_notes"] = "" if value == "_pending_" else value
    return updates


def sync_review_from_markdown(review: dict[str, Any], brief: str) -> dict[str, Any]:
    updates = parse_markdown_review(brief)
    synced = dict(review)
    hard_negatives = []
    for item in review.get("hard_negative_candidates", []):
        next_item = dict(item)
        item_updates = updates.get(str(item.get("id")), {})
        if "status" in item_updates:
            next_item["status"] = item_updates["status"]
        if "review_notes" in item_updates:
            next_item["review_notes"] = item_updates["review_notes"]
        hard_negatives.append(next_item)
    dedupe_clusters = []
    for item in review.get("dedupe_clusters", []):
        next_item = dict(item)
        item_updates = updates.get(str(item.get("id")), {})
        if "status" in item_updates:
            next_item["status"] = item_updates["status"]
        if "review_notes" in item_updates:
            next_item["review_notes"] = item_updates["review_notes"]
        dedupe_clusters.append(next_item)
    synced["hard_negative_candidates"] = hard_negatives
    synced["dedupe_clusters"] = dedupe_clusters
    return synced


def reviewed_missing_notes(items: list[dict[str, Any]], reviewed_statuses: set[str]) -> list[str]:
    return [
        str(item.get("id"))
        for item in items
        if str(item.get("status")) in reviewed_statuses and not note_present(str(item.get("review_notes") or ""))
    ]


def reviewed_invalid_notes(items: list[dict[str, Any]], reviewed_statuses: set[str]) -> list[str]:
    return [
        str(item.get("id"))
        for item in items
        if (
            str(item.get("status")) in reviewed_statuses
            and note_present(str(item.get("review_notes") or ""))
            and not note_substantive(str(item.get("review_notes") or ""))
        )
    ]


def evaluate_review(review: dict[str, Any]) -> dict[str, Any]:
    hard_negatives = list(review.get("hard_negative_candidates", []))
    dedupe_clusters = list(review.get("dedupe_clusters", []))
    hard_statuses = Counter(str(item.get("status") or "") for item in hard_negatives)
    dedupe_statuses = Counter(str(item.get("status") or "") for item in dedupe_clusters)
    invalid_hard = [
        str(item.get("id"))
        for item in hard_negatives
        if str(item.get("status")) not in HARD_NEGATIVE_STATUSES
    ]
    invalid_dedupe = [
        str(item.get("id"))
        for item in dedupe_clusters
        if str(item.get("status")) not in DEDUPE_STATUSES
    ]
    hard_missing = reviewed_missing_notes(hard_negatives, {"accepted", "rejected"})
    hard_invalid = reviewed_invalid_notes(hard_negatives, {"accepted", "rejected"})
    dedupe_missing = reviewed_missing_notes(dedupe_clusters, {"accepted", "rejected"})
    dedupe_invalid = reviewed_invalid_notes(dedupe_clusters, {"accepted", "rejected"})
    failures = []
    if invalid_hard:
        failures.append("embedding helper hard-negative review contains invalid statuses")
    if invalid_dedupe:
        failures.append("embedding helper dedupe review contains invalid statuses")
    if hard_statuses.get("pending_human_acceptance", 0):
        failures.append("embedding helper hard-negative review still has pending candidates")
    if dedupe_statuses.get("pending_review", 0):
        failures.append("embedding helper dedupe review still has pending clusters")
    if hard_missing:
        failures.append("reviewed embedding helper hard-negative candidates are missing notes")
    if hard_invalid:
        failures.append("reviewed embedding helper hard-negative candidates have non-substantive notes")
    if dedupe_missing:
        failures.append("reviewed embedding helper dedupe clusters are missing notes")
    if dedupe_invalid:
        failures.append("reviewed embedding helper dedupe clusters have non-substantive notes")
    if not hard_negatives:
        failures.append("embedding helper review has no hard-negative candidates")
    return {
        "schema": "ax.embedding_helper_review_status_report.v1",
        "review_decision": review.get("decision"),
        "hard_negative_candidates": len(hard_negatives),
        "hard_negative_statuses": dict(sorted(hard_statuses.items())),
        "hard_negative_accepted": hard_statuses.get("accepted", 0),
        "hard_negative_rejected": hard_statuses.get("rejected", 0),
        "hard_negative_pending": hard_statuses.get("pending_human_acceptance", 0),
        "dedupe_clusters": len(dedupe_clusters),
        "dedupe_statuses": dict(sorted(dedupe_statuses.items())),
        "dedupe_accepted": dedupe_statuses.get("accepted", 0),
        "dedupe_rejected": dedupe_statuses.get("rejected", 0),
        "dedupe_pending": dedupe_statuses.get("pending_review", 0),
        "invalid_hard_negative_candidates": invalid_hard,
        "invalid_dedupe_clusters": invalid_dedupe,
        "hard_negative_missing_notes": hard_missing,
        "hard_negative_invalid_notes": hard_invalid,
        "dedupe_missing_notes": dedupe_missing,
        "dedupe_invalid_notes": dedupe_invalid,
        "failures": failures,
        "decision": "ready_for_embedding_helper_export" if not failures else "needs_embedding_helper_review",
    }


def main() -> int:
    args = parse_args()
    review = load_json(args.review)
    if args.mode == "sync":
        review = sync_review_from_markdown(review, Path(args.brief).read_text())
        write_json(args.review, review)
    report = evaluate_review(review)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("embedding helper review status")
        print(f"decision: {report['decision']}")
        print(f"hard negatives accepted/rejected/pending: {report['hard_negative_accepted']}/{report['hard_negative_rejected']}/{report['hard_negative_pending']}")
        print(f"dedupe accepted/rejected/pending: {report['dedupe_accepted']}/{report['dedupe_rejected']}/{report['dedupe_pending']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_for_embedding_helper_export" else 1


if __name__ == "__main__":
    raise SystemExit(main())
