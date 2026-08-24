#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_eval_roundtrip import run_roundtrip  # noqa: E402
from blind_label_review import load_json, write_json  # noqa: E402
from blind_review_workspace import (  # noqa: E402
    build_report as build_workspace_report,
    evaluate_candidates,
    evaluate_review,
    parse_workspace,
    sync_hard_negatives,
    sync_review,
    validate_workspace_updates,
    workspace_progress,
)
from fixture_append import build_report as build_fixture_append_report  # noqa: E402
from fixture_append import combined_rows, load_jsonl, validate_append_rows  # noqa: E402
from hard_negative_export import build_report as build_hard_negative_export_report  # noqa: E402
from hard_negative_export import export_rows, write_jsonl  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the post-human-review blind eval and hard-negative fixture pipeline.")
    parser.add_argument("--workspace", default=".ax/experiments/blind-review-workspace-e63.md")
    parser.add_argument("--sync-workspace", action="store_true")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--hard-negatives", default=".ax/experiments/blind-hard-negative-candidates-e54.json")
    parser.add_argument("--fixtures", default=".ax/experiments/blind-session-section-fixtures-e46.jsonl")
    parser.add_argument("--predictions", default=".ax/experiments/blind-session-section-predictions-e48.jsonl")
    parser.add_argument("--base-fixtures", default=".ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl")
    parser.add_argument("--labeled-out", default=".ax/experiments/blind-session-section-fixtures-e50-labeled.jsonl")
    parser.add_argument("--blind-eval-out", default=".ax/experiments/blind-gate-stack-eval-e50.json")
    parser.add_argument("--blind-roundtrip-report", default=".ax/experiments/blind-eval-roundtrip-e50-report.json")
    parser.add_argument("--append-out", default=".ax/experiments/blind-hard-negative-fixture-append-e55.jsonl")
    parser.add_argument("--append-report", default=".ax/experiments/blind-hard-negative-fixture-append-e55-report.json")
    parser.add_argument("--combined-out", default=".ax/experiments/chunks-e58-with-accepted-hard-negatives.jsonl")
    parser.add_argument("--combined-report", default=".ax/experiments/fixture-append-e58-report.json")
    parser.add_argument("--workspace-report", default=".ax/experiments/blind-review-workspace-e63-report.json")
    parser.add_argument("--out", default=".ax/experiments/blind-post-review-runner-e65.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_or_sync_workspace(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    review = load_json(args.review)
    hard_negatives = load_json(args.hard_negatives)
    if args.sync_workspace:
        updates = parse_workspace(Path(args.workspace).read_text())
        update_failures = validate_workspace_updates(updates, review, hard_negatives)
        if update_failures:
            label_report = evaluate_review(review)
            hard_negative_review_report = evaluate_candidates(hard_negatives)
            workspace_report = build_workspace_report(
                label_report,
                hard_negative_review_report,
                update_failures,
                workspace_progress(review, hard_negatives),
            )
            write_json(args.workspace_report, workspace_report)
            return review, hard_negatives, workspace_report
        review = sync_review(review, updates)
        hard_negatives = sync_hard_negatives(hard_negatives, updates)
        write_json(args.review, review)
        write_json(args.hard_negatives, hard_negatives)
    label_report = evaluate_review(review)
    hard_negative_review_report = evaluate_candidates(hard_negatives)
    workspace_report = build_workspace_report(
        label_report,
        hard_negative_review_report,
        progress=workspace_progress(review, hard_negatives),
    )
    write_json(args.workspace_report, workspace_report)
    return review, hard_negatives, workspace_report


def run_blind_roundtrip(args: argparse.Namespace) -> dict[str, Any]:
    roundtrip_args = SimpleNamespace(
        fixtures=args.fixtures,
        review=args.review,
        brief=args.workspace,
        predictions=args.predictions,
        labeled_out=args.labeled_out,
        eval_out=args.blind_eval_out,
        out=args.blind_roundtrip_report,
        sync=False,
    )
    report = run_roundtrip(roundtrip_args)
    write_json(args.blind_roundtrip_report, report)
    return report


def run_hard_negative_export(args: argparse.Namespace, hard_negatives: dict[str, Any]) -> dict[str, Any]:
    rows = export_rows(list(hard_negatives.get("items", [])))
    write_jsonl(args.append_out, rows)
    report = build_hard_negative_export_report(rows, len(hard_negatives.get("items", [])))
    write_json(args.append_report, report)
    return report


def run_fixture_append(args: argparse.Namespace) -> dict[str, Any]:
    base_rows = load_jsonl(args.base_fixtures)
    append_rows = load_jsonl(args.append_out)
    failures = validate_append_rows(base_rows, append_rows)
    if failures:
        write_jsonl(args.combined_out, [])
    else:
        write_jsonl(args.combined_out, combined_rows(base_rows, append_rows))
    report = build_fixture_append_report(base_rows, append_rows, failures)
    write_json(args.combined_report, report)
    return report


def build_report(stages: dict[str, dict[str, Any]], skipped: list[str]) -> dict[str, Any]:
    failures: list[str] = []
    workspace = stages.get("workspace", {})
    blind = stages.get("blind_roundtrip", {})
    export = stages.get("hard_negative_export", {})
    append = stages.get("fixture_append", {})
    if workspace.get("decision") != "ready_for_roundtrip":
        failures.append("workspace is not ready for post-review run")
        decision = "needs_human_review"
    elif blind.get("decision") != "candidate_blind_gate_stack":
        failures.append("blind gate stack is not ready")
        decision = "needs_gate_stack_work"
    elif export.get("decision") != "ready_to_append_fixtures":
        failures.append("hard-negative export is not ready")
        decision = "needs_accepted_hard_negatives"
    elif append.get("decision") != "ready_to_write_combined_fixtures":
        failures.append("fixture append is not ready")
        decision = "needs_fixture_append_work"
    else:
        decision = "ready_for_next_model_run"
    return {
        "schema": "ax.blind_post_review_runner.v1",
        "stages": stages,
        "skipped": skipped,
        "failures": failures,
        "decision": decision,
    }


def run_pipeline(args: argparse.Namespace) -> dict[str, Any]:
    _, hard_negatives, workspace_report = load_or_sync_workspace(args)
    stages: dict[str, dict[str, Any]] = {"workspace": workspace_report}
    skipped: list[str] = []
    if workspace_report.get("decision") != "ready_for_roundtrip":
        skipped.extend(["blind_roundtrip", "hard_negative_export", "fixture_append"])
        return build_report(stages, skipped)

    stages["blind_roundtrip"] = run_blind_roundtrip(args)
    stages["hard_negative_export"] = run_hard_negative_export(args, hard_negatives)
    if stages["hard_negative_export"].get("decision") == "ready_to_append_fixtures":
        stages["fixture_append"] = run_fixture_append(args)
    else:
        skipped.append("fixture_append")
    return build_report(stages, skipped)


def main() -> int:
    args = parse_args()
    report = run_pipeline(args)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind post-review runner")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        if report["skipped"]:
            print(f"skipped: {report['skipped']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_for_next_model_run" else 1


if __name__ == "__main__":
    raise SystemExit(main())
