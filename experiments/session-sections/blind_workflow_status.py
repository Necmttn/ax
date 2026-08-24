#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


READY_DECISIONS = {
    "ready_for_human_acceptance",
    "ready_for_prioritized_review",
    "ready_for_human_label_comparison",
    "ready_for_blind_gate_eval",
    "ready_for_hard_negative_export",
    "ready_to_append_fixtures",
    "candidate_strict_none_gate",
    "ready_for_consolidated_review",
    "ready_for_roundtrip",
    "ready_for_next_model_run",
    "ready_for_batch_review",
    "ready_for_batch_sync",
    "ready_for_workspace_dry_run",
    "refreshed",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize the blind session-section classifier workflow state.")
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
    parser.add_argument("--review-workspace", default=".ax/experiments/blind-review-workspace-e72-dry-run-report.json")
    parser.add_argument("--review-batch", default=".ax/experiments/blind-review-batch-e77-report.json")
    parser.add_argument("--review-batch-eval", default=".ax/experiments/blind-review-batch-e81-eval-report.json")
    parser.add_argument("--review-batch-sync", default=".ax/experiments/blind-review-batch-e79-sync-report.json")
    parser.add_argument("--review-refresh", default=None)
    parser.add_argument("--post-review", default=".ax/experiments/blind-post-review-runner-e69.json")
    parser.add_argument("--out", default=".ax/experiments/blind-workflow-status-e57.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


DETAIL_KEYS = (
    "blind_label_decision",
    "blind_label_pending",
    "hard_negative_decision",
    "hard_negative_pending",
    "hard_negative_accepted",
    "workspace_update_failures",
    "progress",
    "selected_ordinals",
    "sections",
    "context_enriched_sections",
    "vocabulary_included",
    "allowed_label_count",
    "allowed_target_count",
    "allowed_hard_negative_status_count",
    "missing_ordinals",
    "workspace_sha256",
    "batch_sha256",
    "review_complete",
    "review_pending",
    "hard_negative_required",
    "hard_negative_complete",
    "hard_negative_pending",
    "missing_field_total",
    "invalid_field_total",
    "blocking_field_total",
    "completed_field_total",
    "review_field_total",
    "field_completion_percent",
    "row_completion_percent",
    "missing_field_counts",
    "invalid_field_counts",
    "invalid_refs",
    "incomplete_refs",
    "review_task_total",
    "review_tasks",
    "reviewed_labels_invalid_notes",
    "reviewed_invalid_notes",
    "replaced_ordinals",
    "missing_workspace_ordinals",
    "allow_incomplete",
    "workspace_out",
    "batch",
    "batch_report",
    "batch_eval",
    "batch_sync",
    "status",
    "batch_decision",
    "batch_eval_decision",
    "batch_sync_decision",
    "status_decision",
    "artifact_consistency_decision",
    "dry_run",
    "skipped",
    "stages",
)


def stage_from_report(name: str, report: dict[str, Any]) -> dict[str, Any]:
    decision = str(report.get("decision") or "missing")
    return {
        "name": name,
        "schema": report.get("schema"),
        "decision": decision,
        "ready": decision in READY_DECISIONS,
        "pending": report.get("pending"),
        "accepted": report.get("accepted"),
        "details": {
            key: report.get(key)
            for key in DETAIL_KEYS
            if key in report
        },
        "failures": list(report.get("failures") or []),
    }


def next_actions_for(stages: dict[str, dict[str, Any]], consistency: dict[str, Any] | None = None) -> list[str]:
    actions: list[str] = []
    if consistency and consistency.get("decision") == "stale_artifacts":
        actions.append("regenerate focused batch eval and sync reports from the same batch file")
        return actions
    blind = stages.get("blind_labels", {})
    packet = stages.get("review_packet", {})
    workspace = stages.get("review_workspace", {})
    batch = stages.get("review_batch", {})
    batch_eval = stages.get("review_batch_eval", {})
    batch_sync = stages.get("review_batch_sync", {})
    post_review = stages.get("post_review_runner", {})
    hard_review = stages.get("hard_negative_review", {})
    hard_export = stages.get("hard_negative_export", {})
    if blind.get("decision") == "needs_blind_label_review":
        if workspace.get("decision") == "needs_human_review":
            if batch_eval.get("decision") == "needs_batch_review":
                actions.append("complete focused batch review fields")
            elif batch_sync.get("decision") == "ready_for_workspace_dry_run":
                workspace_out = batch_sync.get("details", {}).get("workspace_out")
                if workspace_out and not str(workspace_out).endswith("blind-review-workspace-e63.md"):
                    actions.append("inspect merged preview or sync reviewed batch into E63")
                actions.append("dry-run classifiers:blind-review-workspace -- --mode=sync --dry-run after batch sync")
            elif batch_eval.get("decision") == "ready_for_batch_sync":
                actions.append("sync reviewed focused batch into E63")
            elif batch.get("decision") == "ready_for_batch_review":
                actions.append("review focused batch")
            actions.append("edit E63 consolidated review workspace")
            if post_review.get("decision") == "needs_human_review":
                if batch_sync.get("decision") != "ready_for_workspace_dry_run":
                    actions.append("dry-run classifiers:blind-review-workspace -- --mode=sync --dry-run before sync")
                actions.append("rerun classifiers:blind-post-review -- --sync-workspace after E63 edits")
        elif packet.get("decision") == "ready_for_consolidated_review":
            actions.append("review E61 consolidated packet")
        actions.append("label E49 blind review rows")
        actions.append("run classifiers:blind-eval-roundtrip -- --sync")
    if hard_review.get("decision") == "needs_human_acceptance":
        actions.append("review E54 hard-negative candidates")
        actions.append("run classifiers:hard-negative-review -- --mode=sync")
    if hard_review.get("decision") == "ready_for_hard_negative_export" and hard_export.get("decision") != "ready_to_append_fixtures":
        actions.append("run classifiers:hard-negative-export to emit accepted fixture rows")
    if not actions:
        actions.append("run blind eval roundtrip and hard-negative export")
    return actions


def build_status(reports: dict[str, dict[str, Any]]) -> dict[str, Any]:
    stages = {name: stage_from_report(name, report) for name, report in reports.items()}
    consistency = artifact_consistency(stages)
    blind_ready = stages.get("blind_labels", {}).get("decision") == "ready_for_blind_gate_eval"
    hard_ready = stages.get("hard_negative_review", {}).get("decision") == "ready_for_hard_negative_export"
    if consistency.get("decision") == "stale_artifacts":
        decision = "needs_artifact_refresh"
    elif blind_ready and hard_ready:
        decision = "ready_for_eval_and_export"
    elif stages.get("blind_labels", {}).get("decision") == "needs_blind_label_review" or stages.get("hard_negative_review", {}).get("decision") == "needs_human_acceptance":
        decision = "needs_human_review"
    else:
        decision = "workflow_ready_partial"
    return {
        "schema": "ax.blind_workflow_status.v1",
        "decision": decision,
        "stages": stages,
        "artifact_consistency": consistency,
        "candidate_gate_status": candidate_gate_status(reports),
        "next_actions": next_actions_for(stages, consistency),
    }


def artifact_consistency(stages: dict[str, dict[str, Any]]) -> dict[str, Any]:
    failures: list[str] = []
    batch_eval_hash = stages.get("review_batch_eval", {}).get("details", {}).get("batch_sha256")
    batch_sync_hash = stages.get("review_batch_sync", {}).get("details", {}).get("batch_sha256")
    if batch_eval_hash and batch_sync_hash and batch_eval_hash != batch_sync_hash:
        failures.append("review_batch_eval and review_batch_sync were generated from different batch contents")
    return {
        "batch_eval_sha256": batch_eval_hash,
        "batch_sync_sha256": batch_sync_hash,
        "failures": failures,
        "decision": "consistent" if not failures else "stale_artifacts",
    }


def candidate_gate_status(reports: dict[str, dict[str, Any]]) -> dict[str, Any]:
    strict = reports.get("strict_none_gate")
    if not strict:
        return {}
    return {
        "strict_none_gate": {
            "decision": strict.get("decision"),
            "blind_eval": strict.get("blind_eval"),
            "unsafe_none_miss_delta": strict.get("unsafe_none_miss_delta", {}),
            "warning": strict.get("warning"),
        }
    }


def main() -> int:
    args = parse_args()
    reports = {
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
        "review_workspace": load_json(args.review_workspace),
        "review_batch": load_json(args.review_batch),
        "review_batch_eval": load_json(args.review_batch_eval),
        "review_batch_sync": load_json(args.review_batch_sync),
        "post_review_runner": load_json(args.post_review),
    }
    if args.review_refresh:
        reports["review_refresh"] = load_json(args.review_refresh)
    status = build_status(reports)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(status, indent=2) + "\n")
    if args.json:
        print(json.dumps(status, indent=2))
    else:
        print("blind workflow status")
        print(f"decision: {status['decision']}")
        print("next actions:")
        for action in status["next_actions"]:
            print(f"- {action}")
        print(f"out: {out}")
    return 0 if status["decision"] == "ready_for_eval_and_export" else 1


if __name__ == "__main__":
    raise SystemExit(main())
