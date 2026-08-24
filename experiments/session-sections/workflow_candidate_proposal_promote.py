#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PROMOTABLE_VERDICTS = {"accept", "revise"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote reviewed workflow-candidate proposal briefs into task drafts.")
    parser.add_argument("--review", default=".ax/experiments/workflow-candidate-proposal-review-current.json")
    parser.add_argument("--out", default=".ax/experiments/workflow-candidate-proposal-promotion-current.json")
    parser.add_argument("--task-dir", default=".ax/tasks/workflow-candidate-promotion-drafts")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def safe_name(value: str) -> str:
    return "".join(char if char.isalnum() else "-" for char in value.lower()).strip("-")


def artifact_instructions(artifact: str) -> list[str]:
    if artifact == "harness":
        return [
            "Create or update an executable harness/check before changing agent guidance.",
            "The harness should fail when the repeated workflow mistake is present.",
        ]
    if artifact == "guidance":
        return [
            "Update the target guidance or skill file with the smallest durable rule that matches the evidence.",
            "Keep the guidance tied to the reviewed rationale instead of broadening it into a generic preference.",
        ]
    return [
        "Turn the reviewed proposal into the smallest concrete artifact that preserves evidence and rationale.",
    ]


def draft_path_for(proposal: dict[str, Any], task_dir: str, index: int) -> str:
    action = safe_name(str(proposal.get("action") or "proposal"))
    return str(Path(task_dir) / f"{index:02d}-{action}.md")


def render_task_draft(proposal: dict[str, Any]) -> str:
    review = proposal.get("review") or {}
    artifact = str(proposal.get("recommended_artifact") or "review")
    lines = [
        f"# {proposal.get('title') or proposal.get('action') or 'Workflow candidate proposal'}",
        "",
        f"- Source proposal: `{proposal.get('id')}`",
        f"- Graph action: `{proposal.get('action')}`",
        f"- Verdict: `{review.get('verdict')}`",
        f"- Recommended artifact: `{artifact}`",
        f"- Target: `{review.get('target')}`",
        f"- Source brief: `{proposal.get('brief_path')}`",
        "",
        "## Reviewer Rationale",
        "",
        str(review.get("rationale") or "").strip(),
        "",
        "## Proposed Change",
        "",
        str(review.get("proposed_change") or "").strip(),
        "",
        "## Implementation Notes",
        "",
    ]
    lines.extend([f"- {instruction}" for instruction in artifact_instructions(artifact)])
    lines.extend([
        "- Preserve the source proposal id and reviewed rationale in any follow-up artifact.",
        "- Do not apply this draft if the review report is no longer `workflow_candidate_proposal_reviews_ready`.",
        "",
    ])
    return "\n".join(lines)


def build_promotion(review_report: dict[str, Any], review_path: str, task_dir: str) -> tuple[dict[str, Any], list[dict[str, str]]]:
    proposals = list(review_report.get("proposals") or [])
    failures = []
    drafts: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    draft_files: list[dict[str, str]] = []

    if review_report.get("decision") != "workflow_candidate_proposal_reviews_ready":
        failures.append("proposal review report is not ready")
    for proposal in proposals:
        review = proposal.get("review") or {}
        verdict = str(review.get("verdict") or "")
        if verdict in PROMOTABLE_VERDICTS and not failures:
            path = draft_path_for(proposal, task_dir, len(drafts) + 1)
            drafts.append({
                "id": proposal.get("id"),
                "title": proposal.get("title"),
                "action": proposal.get("action"),
                "recommended_artifact": proposal.get("recommended_artifact"),
                "verdict": verdict,
                "target": review.get("target"),
                "task_path": path,
            })
            draft_files.append({"path": path, "content": render_task_draft(proposal)})
        else:
            reason = "review_not_ready" if failures else "verdict_not_promotable"
            skipped.append({"id": str(proposal.get("id") or ""), "verdict": verdict, "reason": reason})

    if not failures and not drafts:
        failures.append("no accepted or revised proposals to promote")

    report = {
        "schema": "ax.workflow_candidate_proposal_promotion.v1",
        "review_report": review_path,
        "task_dir": task_dir,
        "proposal_count": len(proposals),
        "emitted_draft_count": len(drafts),
        "skipped_proposal_count": len(skipped),
        "drafts": drafts,
        "skipped_proposals": skipped,
        "failures": failures,
        "decision": "workflow_candidate_proposal_promotion_ready" if not failures else "needs_workflow_candidate_proposal_review",
    }
    return report, draft_files


def write_drafts(draft_files: list[dict[str, str]]) -> None:
    for draft in draft_files:
        path = Path(draft["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(draft["content"])


def main() -> int:
    args = parse_args()
    report, draft_files = build_promotion(load_json(args.review), args.review, args.task_dir)
    Path(args.task_dir).mkdir(parents=True, exist_ok=True)
    if report["decision"] == "workflow_candidate_proposal_promotion_ready":
        write_drafts(draft_files)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("workflow candidate proposal promotion")
        print(f"decision: {report['decision']}")
        print(f"drafts: {report['emitted_draft_count']}")
        print(f"skipped: {report['skipped_proposal_count']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
