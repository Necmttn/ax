#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_label_review import write_json  # noqa: E402
from blind_fixture_pack import ALLOWED_LABELS, TARGET_HINTS  # noqa: E402
from blind_review_batch import evaluate_batch, insert_post_edit_commands, insert_review_guidance, insert_review_workload_summary, load_json, packet_context_by_id, render_batch, section_refs, sync_batch  # noqa: E402
from blind_workflow_status import build_status  # noqa: E402
from hard_negative_review import VALID_STATUSES  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh focused batch, eval, guarded sync, and workflow status as one coherent bundle.")
    parser.add_argument("--workspace", default=".ax/experiments/blind-review-workspace-e63.md")
    parser.add_argument("--workspace-report", default=".ax/experiments/blind-review-workspace-e76-progress-refs-report.json")
    parser.add_argument("--packet", default=".ax/experiments/blind-review-packet-e61.json")
    parser.add_argument("--batch", default=".ax/experiments/blind-review-batch-current.md")
    parser.add_argument("--batch-report", default=".ax/experiments/blind-review-batch-current-report.json")
    parser.add_argument("--batch-eval", default=".ax/experiments/blind-review-batch-current-eval-report.json")
    parser.add_argument("--batch-sync", default=".ax/experiments/blind-review-batch-current-sync-report.json")
    parser.add_argument("--workspace-out", default=".ax/experiments/blind-review-workspace-current-preview.md")
    parser.add_argument("--status", default=".ax/experiments/blind-workflow-status-current.json")
    parser.add_argument("--summary", default=".ax/experiments/blind-review-batch-current-refresh-report.json")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--allow-incomplete", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    add_status_args(parser)
    return parser.parse_args()


def add_status_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--blind-label-review", default=".ax/experiments/blind-session-section-label-review-e49-report.json")
    parser.add_argument("--blind-roundtrip", default=".ax/experiments/blind-eval-roundtrip-e50-report.json")
    parser.add_argument("--suggestions", default=".ax/experiments/blind-session-section-label-suggestions-e51-report.json")
    parser.add_argument("--priority", default=".ax/experiments/blind-session-section-review-priority-e52-report.json")
    parser.add_argument("--sensitivity", default=".ax/experiments/blind-sensitivity-e53.json")
    parser.add_argument("--hard-negatives", default=".ax/experiments/blind-hard-negative-candidates-e54-report.json")
    parser.add_argument("--hard-negative-export", default=".ax/experiments/blind-hard-negative-fixture-append-e55-report.json")
    parser.add_argument("--hard-negative-review", default=".ax/experiments/blind-hard-negative-review-e56-report.json")
    parser.add_argument("--strict-none-gate", default=".ax/experiments/strict-none-gate-e59.json")
    parser.add_argument("--review-packet", default=".ax/experiments/blind-review-packet-e61-report.json")
    parser.add_argument("--post-review", default=".ax/experiments/blind-post-review-runner-e69.json")


def write_text(path: str, value: str) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(value)


def build_status_reports(args: argparse.Namespace) -> dict[str, dict[str, Any]]:
    return {
        "blind_labels": load_json(args.blind_label_review),
        "blind_roundtrip": load_json(args.blind_roundtrip),
        "suggestions": load_json(args.suggestions),
        "priority": load_json(args.priority),
        "sensitivity": load_json(args.sensitivity),
        "hard_negatives": load_json(args.hard_negatives),
        "hard_negative_export": load_json(args.hard_negative_export),
        "hard_negative_review": load_json(args.hard_negative_review),
        "strict_none_gate": load_json(args.strict_none_gate),
        "review_packet": load_json(args.review_packet),
        "review_workspace": load_json(args.workspace_report),
        "review_batch": load_json(args.batch_report),
        "review_batch_eval": load_json(args.batch_eval),
        "review_batch_sync": load_json(args.batch_sync),
        "post_review_runner": load_json(args.post_review),
    }


def refresh(args: argparse.Namespace) -> dict[str, Any]:
    workspace = Path(args.workspace).read_text()
    packet_path = getattr(args, "packet", ".ax/experiments/blind-review-packet-e61.json")
    packet = load_json(packet_path) if Path(packet_path).exists() else {"items": []}
    existing_batch_path = Path(args.batch)
    existing_batch = existing_batch_path.read_text() if existing_batch_path.exists() else ""
    existing_batch_eval = evaluate_batch(existing_batch) if existing_batch else {"decision": "needs_batch_review"}
    if existing_batch_eval["decision"] == "ready_for_batch_sync":
        batch_markdown = existing_batch
        batch_report = load_json(args.batch_report) if Path(args.batch_report).exists() else {
            "schema": "ax.blind_review_batch_report.v1",
            "workspace_sha256": "",
            "selected_ordinals": [ref["ordinal"] for ref in section_refs(batch_markdown)],
            "sections": existing_batch_eval["sections"],
            "context_enriched_sections": 0,
            "vocabulary_included": True,
            "allowed_label_count": len(ALLOWED_LABELS),
            "allowed_target_count": len(TARGET_HINTS),
            "allowed_hard_negative_status_count": len(VALID_STATUSES),
            "missing_ordinals": [],
            "failures": [],
            "decision": "ready_for_batch_review",
        }
        batch_source = "existing_reviewed_batch"
    else:
        batch_markdown, batch_report = render_batch(workspace, load_json(args.workspace_report), args.limit, packet_context_by_id(packet))
        batch_markdown = insert_review_guidance(insert_post_edit_commands(insert_review_workload_summary(batch_markdown, evaluate_batch(batch_markdown))))
        write_text(args.batch, batch_markdown)
        write_json(args.batch_report, batch_report)
        batch_source = "regenerated_from_workspace"

    batch_eval = evaluate_batch(batch_markdown)
    write_json(args.batch_eval, batch_eval)

    merged_workspace, batch_sync = sync_batch(workspace, batch_markdown, args.workspace_out, args.dry_run, args.allow_incomplete)
    if not args.dry_run and batch_sync["decision"] == "ready_for_workspace_dry_run":
        write_text(args.workspace_out, merged_workspace)
    write_json(args.batch_sync, batch_sync)

    status = build_status(build_status_reports(args))
    write_json(args.status, status)

    summary = {
        "schema": "ax.blind_review_batch_refresh_report.v1",
        "batch": args.batch,
        "batch_report": args.batch_report,
        "batch_eval": args.batch_eval,
        "batch_sync": args.batch_sync,
        "workspace_out": args.workspace_out,
        "status": args.status,
        "batch_decision": batch_report["decision"],
        "batch_eval_decision": batch_eval["decision"],
        "batch_sync_decision": batch_sync["decision"],
        "status_decision": status["decision"],
        "artifact_consistency_decision": status.get("artifact_consistency", {}).get("decision"),
        "batch_source": batch_source,
        "failures": list(batch_report.get("failures") or []) + list(batch_eval.get("failures") or []) + list(batch_sync.get("failures") or []),
        "decision": "refreshed",
    }
    write_json(args.summary, summary)
    return summary


def main() -> int:
    args = parse_args()
    summary = refresh(args)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("blind review batch refresh")
        print(f"batch_eval_decision: {summary['batch_eval_decision']}")
        print(f"batch_sync_decision: {summary['batch_sync_decision']}")
        print(f"status_decision: {summary['status_decision']}")
        print(f"summary: {args.summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
