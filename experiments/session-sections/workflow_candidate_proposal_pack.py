#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ACTION_TEMPLATES = {
    "add_verification_gate": {
        "artifact": "harness",
        "title": "Add a verification gate for recurring agent work",
        "question": "Which repeated workflow needs an executable verification check before the agent claims completion?",
    },
    "add_context_guardrail": {
        "artifact": "guidance",
        "title": "Add a context guardrail for recurring correction loops",
        "question": "Which repeated correction should become durable agent guidance or a guardrail?",
    },
    "record_guidance_or_environment_preference": {
        "artifact": "guidance",
        "title": "Record durable environment or workflow preference",
        "question": "Which environment/tooling preference should be made explicit for future agents?",
    },
    "record_approval_checkpoint": {
        "artifact": "guidance",
        "title": "Record approval checkpoint pattern",
        "question": "Which approval/continue checkpoint should become workflow-state guidance?",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create reviewable proposal briefs from a combined workflow-candidate report.")
    parser.add_argument("--combined", default=".ax/experiments/workflow-candidate-combined-current.json")
    parser.add_argument("--out", default=".ax/experiments/workflow-candidate-proposal-pack-current.json")
    parser.add_argument("--brief-dir", default=".ax/tasks/workflow-candidate-proposals")
    parser.add_argument("--limit", type=int, default=4)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def safe_name(value: str) -> str:
    return "".join(char if char.isalnum() else "-" for char in value.lower()).strip("-")


def template_for(action: str) -> dict[str, str]:
    return ACTION_TEMPLATES.get(action, {
        "artifact": "review",
        "title": f"Review workflow candidate action: {action}",
        "question": "What durable agent change, if any, is justified by this evidence?",
    })


def evidence_strength(action: dict[str, Any]) -> int:
    return int(action.get("total_evidence_fact_count") or 0)


def task_like_count(action: dict[str, Any]) -> int:
    return int(action.get("total_task_like_count") or 0)


def proposal_for_action(action: dict[str, Any], index: int, brief_dir: str) -> dict[str, Any]:
    action_name = str(action.get("action") or "unknown")
    template = template_for(action_name)
    source_rows = []
    for source in action.get("sources") or []:
        if not source.get("present"):
            continue
        source_rows.append({
            "source_kind": source.get("source_kind"),
            "support_count": int(source.get("support_count") or 0),
            "evidence_fact_count": int(source.get("evidence_fact_count") or 0),
            "task_like_count": int(source.get("task_like_count") or 0),
            "labels": list(source.get("labels") or []),
        })
    proposal_id = f"workflow-candidate-proposal:{index:02d}-{safe_name(action_name)}"
    brief_path = str(Path(brief_dir) / f"{index:02d}-{safe_name(action_name)}.md")
    return {
        "id": proposal_id,
        "action": action_name,
        "title": template["title"],
        "recommended_artifact": template["artifact"],
        "review_question": template["question"],
        "support_count": int(action.get("total_support_count") or 0),
        "evidence_fact_count": evidence_strength(action),
        "task_like_count": task_like_count(action),
        "source_count": len(source_rows),
        "sources": source_rows,
        "brief_path": brief_path,
        "status": "pending_review",
    }


def render_brief(proposal: dict[str, Any]) -> str:
    lines = [
        f"# {proposal['title']}",
        "",
        f"- Proposal id: `{proposal['id']}`",
        f"- Graph action: `{proposal['action']}`",
        f"- Recommended artifact: `{proposal['recommended_artifact']}`",
        f"- Support count: `{proposal['support_count']}`",
        f"- Evidence facts: `{proposal['evidence_fact_count']}`",
        f"- Task-like evidence: `{proposal['task_like_count']}`",
        f"- Review status: `pending`",
        "",
        "## Review Question",
        "",
        proposal["review_question"],
        "",
        "## Source Evidence",
        "",
    ]
    for source in proposal["sources"]:
        lines.extend([
            f"### {source['source_kind']}",
            "",
            f"- Support: `{source['support_count']}`",
            f"- Evidence facts: `{source['evidence_fact_count']}`",
            f"- Task-like evidence: `{source['task_like_count']}`",
            f"- Labels: `{', '.join(source['labels']) or 'none'}`",
            "",
        ])
    lines.extend([
        "## Reviewer Decision",
        "",
        "- Verdict: `pending`",
        "- Rationale:",
        "- Proposed change:",
        "- Target file/skill/harness:",
        "",
        "## Guardrails",
        "",
        "- Do not apply this proposal without preserving evidence refs.",
        "- Prefer harness changes for verification gates and guidance changes for preferences or corrections.",
        "- Reject the proposal if the evidence is mostly delegated task scaffolding or does not imply a durable agent behavior change.",
        "",
    ])
    return "\n".join(lines)


def build_report(combined: dict[str, Any], combined_path: str, brief_dir: str, limit: int) -> dict[str, Any]:
    actions = sorted(
        list(combined.get("actions") or []),
        key=lambda action: (-evidence_strength(action), task_like_count(action), str(action.get("action") or "")),
    )
    selected = actions[: max(1, limit)]
    proposals = [proposal_for_action(action, index + 1, brief_dir) for index, action in enumerate(selected)]
    failures = []
    if combined.get("decision") != "workflow_candidate_sources_combined":
        failures.append("combined workflow candidate report is not ready")
    if not proposals:
        failures.append("no workflow actions available for proposal pack")
    if not any(proposal["recommended_artifact"] == "harness" for proposal in proposals):
        failures.append("proposal pack has no harness candidate")
    return {
        "schema": "ax.workflow_candidate_proposal_pack.v1",
        "combined_report": combined_path,
        "brief_dir": brief_dir,
        "proposal_count": len(proposals),
        "recommended_artifacts": {
            "harness": sum(1 for proposal in proposals if proposal["recommended_artifact"] == "harness"),
            "guidance": sum(1 for proposal in proposals if proposal["recommended_artifact"] == "guidance"),
            "review": sum(1 for proposal in proposals if proposal["recommended_artifact"] == "review"),
        },
        "proposals": proposals,
        "failures": failures,
        "decision": "workflow_candidate_proposal_pack_ready" if not failures else "needs_workflow_candidate_proposal_review",
    }


def write_briefs(report: dict[str, Any]) -> None:
    brief_dir = Path(str(report["brief_dir"]))
    brief_dir.mkdir(parents=True, exist_ok=True)
    for proposal in report["proposals"]:
        Path(str(proposal["brief_path"])).write_text(render_brief(proposal))


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.combined), args.combined, args.brief_dir, args.limit)
    write_briefs(report)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("workflow candidate proposal pack")
        print(f"decision: {report['decision']}")
        print(f"proposals: {report['proposal_count']}")
        print(f"brief dir: {report['brief_dir']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "workflow_candidate_proposal_pack_ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
