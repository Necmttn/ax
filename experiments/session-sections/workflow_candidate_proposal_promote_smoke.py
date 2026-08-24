#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from workflow_candidate_proposal_promote import build_promotion, write_drafts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a ready-review smoke for workflow-candidate proposal promotion.")
    parser.add_argument("--review-out", default=".ax/experiments/workflow-candidate-proposal-ready-smoke-review-current.json")
    parser.add_argument("--out", default=".ax/experiments/workflow-candidate-proposal-ready-smoke-promotion-current.json")
    parser.add_argument("--task-dir", default=".ax/experiments/workflow-candidate-proposal-ready-smoke-drafts")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def proposal(index: int, action: str, artifact: str, verdict: str) -> dict[str, Any]:
    title = {
        "add_verification_gate": "Add a verification gate for recurring agent work",
        "record_guidance_or_environment_preference": "Record durable environment or workflow preference",
        "record_approval_checkpoint": "Record approval checkpoint pattern",
    }[action]
    return {
        "id": f"workflow-candidate-proposal:{index:02d}-{action}",
        "title": title,
        "action": action,
        "recommended_artifact": artifact,
        "brief_path": f".ax/tasks/workflow-candidate-proposals/{index:02d}-{action}.md",
        "review": {
            "verdict": verdict,
            "rationale": f"Fixture rationale for {action}.",
            "proposed_change": f"Fixture proposed change for {action}.",
            "target": "tests/workflow/verification-claim.test.ts" if artifact == "harness" else "AGENTS.md",
        },
        "missing_fields": [],
        "invalid_fields": [],
        "status": "review_ready",
    }


def ready_review_report() -> dict[str, Any]:
    proposals = [
        proposal(1, "add_verification_gate", "harness", "accept"),
        proposal(2, "record_guidance_or_environment_preference", "guidance", "revise"),
        proposal(3, "record_approval_checkpoint", "guidance", "reject"),
    ]
    return {
        "schema": "ax.workflow_candidate_proposal_review.v1",
        "proposal_pack": "ready-smoke-fixture",
        "proposal_count": len(proposals),
        "proposals": proposals,
        "totals": {
            "proposal_count": len(proposals),
            "ready_count": len(proposals),
            "pending_count": 0,
            "invalid_count": 0,
            "missing_field_count": 0,
        },
        "failures": [],
        "decision": "workflow_candidate_proposal_reviews_ready",
    }


def build_smoke(review_out: str, out: str, task_dir: str) -> dict[str, Any]:
    review = ready_review_report()
    report, draft_files = build_promotion(review, review_out, task_dir)
    Path(task_dir).mkdir(parents=True, exist_ok=True)
    if report["decision"] == "workflow_candidate_proposal_promotion_ready":
        write_drafts(draft_files)
    Path(review_out).parent.mkdir(parents=True, exist_ok=True)
    Path(review_out).write_text(json.dumps(review, indent=2) + "\n")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(report, indent=2) + "\n")
    return {
        "schema": "ax.workflow_candidate_proposal_promotion_smoke.v1",
        "review_report": review_out,
        "promotion_report": out,
        "task_dir": task_dir,
        "review_decision": review["decision"],
        "promotion_decision": report["decision"],
        "proposal_count": report["proposal_count"],
        "emitted_draft_count": report["emitted_draft_count"],
        "skipped_proposal_count": report["skipped_proposal_count"],
        "draft_paths": [draft["task_path"] for draft in report["drafts"]],
        "failures": report["failures"],
        "decision": "workflow_candidate_proposal_ready_smoke_passed" if (
            review["decision"] == "workflow_candidate_proposal_reviews_ready"
            and report["decision"] == "workflow_candidate_proposal_promotion_ready"
            and report["emitted_draft_count"] == 2
            and report["skipped_proposal_count"] == 1
        ) else "workflow_candidate_proposal_ready_smoke_failed",
    }


def main() -> int:
    args = parse_args()
    smoke = build_smoke(args.review_out, args.out, args.task_dir)
    if args.json:
        print(json.dumps(smoke, indent=2))
    else:
        print("workflow candidate proposal ready-review smoke")
        print(f"decision: {smoke['decision']}")
        print(f"promotion decision: {smoke['promotion_decision']}")
        print(f"drafts: {smoke['emitted_draft_count']}")
        print(f"skipped: {smoke['skipped_proposal_count']}")
    return 0 if smoke["decision"] == "workflow_candidate_proposal_ready_smoke_passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
