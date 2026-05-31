#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


VALID_VERDICTS = {
    "accept": "accept",
    "accepted": "accept",
    "reject": "reject",
    "rejected": "reject",
    "revise": "revise",
    "needs_revision": "revise",
    "needs-revision": "revise",
}

PENDING_VALUES = {"", "pending", "_pending_", "`pending`", "todo", "tbd"}
REQUIRED_FIELDS = ["verdict", "rationale", "proposed_change", "target"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate workflow-candidate proposal brief reviewer fields.")
    parser.add_argument("--pack", default=".ax/experiments/workflow-candidate-proposal-pack-current.json")
    parser.add_argument("--out", default=".ax/experiments/workflow-candidate-proposal-review-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def clean_value(value: str | None) -> str:
    if value is None:
        return ""
    value = value.strip()
    if value.startswith("`") and value.endswith("`") and len(value) >= 2:
        value = value[1:-1].strip()
    return value


def normalized_required_value(value: str | None) -> str:
    cleaned = clean_value(value)
    return "" if cleaned.lower() in PENDING_VALUES else cleaned


def field_after_label(markdown: str, label: str) -> str:
    pattern = re.compile(rf"^[ \t]*-[ \t]*{re.escape(label)}:[ \t]*(.*)$", re.MULTILINE)
    match = pattern.search(markdown)
    return clean_value(match.group(1) if match else "")


def proposal_id_from_markdown(markdown: str) -> str:
    return field_after_label(markdown, "Proposal id")


def parse_review(markdown: str) -> dict[str, str]:
    verdict_raw = normalized_required_value(field_after_label(markdown, "Verdict")).lower()
    verdict = VALID_VERDICTS.get(verdict_raw, verdict_raw)
    return {
        "verdict": verdict,
        "rationale": normalized_required_value(field_after_label(markdown, "Rationale")),
        "proposed_change": normalized_required_value(field_after_label(markdown, "Proposed change")),
        "target": normalized_required_value(field_after_label(markdown, "Target file/skill/harness")),
    }


def evaluate_proposal(proposal: dict[str, Any]) -> dict[str, Any]:
    brief_path = str(proposal.get("brief_path") or "")
    path = Path(brief_path)
    missing_fields: list[str] = []
    invalid_fields: list[str] = []
    review = {"verdict": "", "rationale": "", "proposed_change": "", "target": ""}
    parsed_proposal_id = ""

    if not brief_path or not path.exists():
        missing_fields.extend(REQUIRED_FIELDS)
        invalid_fields.append("brief_path")
    else:
        markdown = path.read_text()
        parsed_proposal_id = proposal_id_from_markdown(markdown)
        review = parse_review(markdown)
        if parsed_proposal_id and parsed_proposal_id != proposal.get("id"):
            invalid_fields.append("proposal_id")
        for field in REQUIRED_FIELDS:
            if not review[field]:
                missing_fields.append(field)
        if review["verdict"] and review["verdict"] not in set(VALID_VERDICTS.values()):
            invalid_fields.append("verdict")

    if invalid_fields:
        status = "invalid_review"
    elif missing_fields:
        status = "pending_review"
    else:
        status = "review_ready"

    return {
        "id": proposal.get("id"),
        "title": proposal.get("title"),
        "action": proposal.get("action"),
        "recommended_artifact": proposal.get("recommended_artifact"),
        "brief_path": brief_path,
        "parsed_proposal_id": parsed_proposal_id,
        "review": review,
        "missing_fields": missing_fields,
        "invalid_fields": invalid_fields,
        "status": status,
    }


def build_report(pack: dict[str, Any], pack_path: str) -> dict[str, Any]:
    proposals = [evaluate_proposal(proposal) for proposal in pack.get("proposals") or []]
    ready_count = sum(1 for proposal in proposals if proposal["status"] == "review_ready")
    pending_count = sum(1 for proposal in proposals if proposal["status"] == "pending_review")
    invalid_count = sum(1 for proposal in proposals if proposal["status"] == "invalid_review")
    missing_field_count = sum(len(proposal["missing_fields"]) for proposal in proposals)
    failures = []
    if not proposals:
        failures.append("proposal pack has no proposals")
    if pending_count or invalid_count:
        failures.append("proposal briefs are not promotion-ready")
    return {
        "schema": "ax.workflow_candidate_proposal_review.v1",
        "proposal_pack": pack_path,
        "proposal_count": len(proposals),
        "proposals": proposals,
        "totals": {
            "proposal_count": len(proposals),
            "ready_count": ready_count,
            "pending_count": pending_count,
            "invalid_count": invalid_count,
            "missing_field_count": missing_field_count,
        },
        "failures": failures,
        "decision": "workflow_candidate_proposal_reviews_ready" if not failures else "needs_workflow_candidate_proposal_review",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.pack), args.pack)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("workflow candidate proposal review")
        print(f"decision: {report['decision']}")
        print(f"proposals: {report['proposal_count']}")
        print(f"ready: {report['totals']['ready_count']}")
        print(f"pending: {report['totals']['pending_count']}")
        print(f"invalid: {report['totals']['invalid_count']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
