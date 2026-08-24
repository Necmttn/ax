#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_label_review import write_json  # noqa: E402
from hard_negative_export import write_jsonl  # noqa: E402

WORKFLOW_FIXTURE_LABELS = {
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
    parser = argparse.ArgumentParser(description="Build a checked combined fixture JSONL from base fixtures plus accepted append rows.")
    parser.add_argument("--base", default=".ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl")
    parser.add_argument("--append", default=".ax/experiments/blind-hard-negative-fixture-append-e55.jsonl")
    parser.add_argument("--out", default=".ax/experiments/chunks-e58-with-accepted-hard-negatives.jsonl")
    parser.add_argument("--report", default=".ax/experiments/fixture-append-e58-report.json")
    parser.add_argument("--allow-existing-identical", action="store_true", help="Treat append rows that already exist in base with identical content as already promoted.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def existing_identical_ids(base_rows: list[dict[str, Any]], append_rows: list[dict[str, Any]]) -> set[str]:
    base_by_id = {str(row.get("id")): row for row in base_rows}
    return {str(row.get("id")) for row in append_rows if base_by_id.get(str(row.get("id"))) == row}


def new_append_rows(base_rows: list[dict[str, Any]], append_rows: list[dict[str, Any]], allow_existing_identical: bool = False) -> list[dict[str, Any]]:
    if not allow_existing_identical:
        return append_rows
    already_existing = existing_identical_ids(base_rows, append_rows)
    return [row for row in append_rows if str(row.get("id")) not in already_existing]


def validate_append_rows(base_rows: list[dict[str, Any]], append_rows: list[dict[str, Any]], allow_existing_identical: bool = False) -> list[str]:
    failures: list[str] = []
    if not append_rows:
        failures.append("no append rows supplied")
        return failures
    base_ids = {str(row.get("id")) for row in base_rows}
    append_ids = [str(row.get("id")) for row in append_rows]
    duplicate_existing = sorted(set(append_ids).intersection(base_ids))
    duplicate_append = sorted({row_id for row_id in append_ids if append_ids.count(row_id) > 1})
    already_existing = existing_identical_ids(base_rows, append_rows) if allow_existing_identical else set()
    conflicting_existing = [row_id for row_id in duplicate_existing if row_id not in already_existing]
    if duplicate_existing and not allow_existing_identical:
        failures.append(f"append rows duplicate existing fixture ids: {', '.join(duplicate_existing[:5])}")
    elif conflicting_existing:
        failures.append(f"append rows conflict with existing fixture ids: {', '.join(conflicting_existing[:5])}")
    if duplicate_append:
        failures.append(f"append rows contain duplicate ids: {', '.join(duplicate_append[:5])}")
    invalid_hard_negatives = []
    invalid_embedding_helper = []
    invalid_workflow = []
    invalid_sources = []
    for row in append_rows:
        source_group = str(row.get("source_group") or "")
        label = str(row.get("label") or "")
        if source_group == "blind-hard-negative":
            if label != "none":
                invalid_hard_negatives.append(str(row.get("id")))
            continue
        if source_group == "embedding-helper-hard-negative":
            if (
                label != "none"
                or not str(row.get("review_notes") or "").strip()
                or not str(row.get("source_candidate_id") or "").strip()
                or not str(row.get("source_fixture_id") or "").strip()
            ):
                invalid_embedding_helper.append(str(row.get("id")))
            continue
        if source_group == "workflow-candidate":
            if (
                str(row.get("review_status") or "") != "accepted"
                or label not in WORKFLOW_FIXTURE_LABELS
                or not str(row.get("review_notes") or "").strip()
            ):
                invalid_workflow.append(str(row.get("id")))
            continue
        invalid_sources.append(str(row.get("id")))
    if invalid_hard_negatives:
        failures.append("blind hard-negative append rows must keep label none")
    if invalid_embedding_helper:
        failures.append("embedding-helper hard-negative append rows must be accepted reviewed none fixtures")
    if invalid_workflow:
        failures.append("workflow-candidate append rows must be accepted reviewed classifier fixtures")
    if invalid_sources:
        failures.append("append rows must come from blind-hard-negative, embedding-helper-hard-negative, or workflow-candidate sources")
    return failures


def combined_rows(base_rows: list[dict[str, Any]], append_rows: list[dict[str, Any]], allow_existing_identical: bool = False) -> list[dict[str, Any]]:
    return list(base_rows) + new_append_rows(base_rows, append_rows, allow_existing_identical)


def build_report(base_rows: list[dict[str, Any]], append_rows: list[dict[str, Any]], failures: list[str], allow_existing_identical: bool = False) -> dict[str, Any]:
    labels = Counter(str(row.get("label")) for row in append_rows)
    already_existing = existing_identical_ids(base_rows, append_rows) if allow_existing_identical else set()
    new_rows = new_append_rows(base_rows, append_rows, allow_existing_identical)
    return {
        "schema": "ax.fixture_append_report.v1",
        "base_rows": len(base_rows),
        "append_rows": len(append_rows),
        "new_append_rows": len(new_rows),
        "already_existing_rows": len(already_existing),
        "combined_rows": len(base_rows) + len(new_rows),
        "append_label_counts": dict(sorted(labels.items())),
        "failures": failures,
        "decision": "ready_to_write_combined_fixtures" if not failures else "needs_accepted_append_rows",
    }


def main() -> int:
    args = parse_args()
    base_rows = load_jsonl(args.base)
    append_rows = load_jsonl(args.append)
    failures = validate_append_rows(base_rows, append_rows, allow_existing_identical=args.allow_existing_identical)
    if not failures:
        write_jsonl(args.out, combined_rows(base_rows, append_rows, allow_existing_identical=args.allow_existing_identical))
    else:
        write_jsonl(args.out, [])
    report = build_report(base_rows, append_rows, failures, allow_existing_identical=args.allow_existing_identical)
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("fixture append report")
        print(f"base rows: {report['base_rows']}")
        print(f"append rows: {report['append_rows']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_to_write_combined_fixtures" else 1


if __name__ == "__main__":
    raise SystemExit(main())
