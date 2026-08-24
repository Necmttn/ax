#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


PROMOTABLE_VERDICTS = {"accept", "revise"}
REJECT_THRESHOLD = 0.30


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create graph promotion candidates from reviewed section candidates.")
    parser.add_argument("--review", default=".ax/experiments/graph-usefulness-review.json")
    parser.add_argument("--out", default=".ax/experiments/graph-promotion-plan.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def fact_type_for_action(action: str) -> str:
    if action == "add_context_guardrail":
        return "candidate_context_guardrail"
    if action == "record_guidance_or_environment_preference":
        return "candidate_preference"
    if action == "add_verification_gate":
        return "candidate_verification_gate"
    return "candidate_section_pattern"


def promotion_fact(candidate: dict[str, Any]) -> dict[str, Any]:
    candidate_id = str(candidate.get("candidate_id"))
    action = str(candidate.get("proposed_action"))
    evidence_refs = sorted({
        ref
        for example in candidate.get("examples", [])
        for ref in example.get("evidence", [])
    })
    return {
        "id": f"promotion:{candidate_id}",
        "source_candidate_id": candidate_id,
        "fact_type": fact_type_for_action(action),
        "section_type": candidate.get("section_type"),
        "proposed_action": action,
        "verdict": candidate.get("verdict"),
        "rationale": candidate.get("rationale"),
        "sections": candidate.get("sections"),
        "evidence_refs": evidence_refs,
    }


def promotion_edges(fact: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "from": fact["id"],
            "to": ref,
            "edge_type": "supported_by",
        }
        for ref in fact.get("evidence_refs", [])
    ]


def create_promotion_plan(review: dict[str, Any]) -> dict[str, Any]:
    candidates = review.get("candidates") or []
    pending = [candidate.get("candidate_id") for candidate in candidates if candidate.get("verdict") == "pending"]
    reviewed = [candidate for candidate in candidates if candidate.get("verdict") in {"accept", "revise", "reject"}]
    rejected = [candidate for candidate in reviewed if candidate.get("verdict") == "reject"]
    promotable = [candidate for candidate in reviewed if candidate.get("verdict") in PROMOTABLE_VERDICTS]
    missing_rationale = [
        candidate.get("candidate_id")
        for candidate in reviewed
        if not str(candidate.get("rationale") or "").strip()
    ]
    missing_evidence = [
        candidate.get("candidate_id")
        for candidate in promotable
        if not any(example.get("evidence") for example in candidate.get("examples", []))
    ]
    facts = [promotion_fact(candidate) for candidate in promotable]
    edges = [
        edge
        for fact in facts
        for edge in promotion_edges(fact)
    ]
    reject_rate = len(rejected) / len(reviewed) if reviewed else None
    failures = []
    if pending:
        failures.append("review still has pending candidates")
    if not reviewed:
        failures.append("no reviewed candidates")
    if missing_rationale:
        failures.append("reviewed candidates are missing rationales")
    if missing_evidence:
        failures.append("promotable candidates are missing evidence")
    if reject_rate is not None and reject_rate >= REJECT_THRESHOLD:
        failures.append("manual review reject rate is not below 30%")
    return {
        "schema": "ax.graph_promotion_plan.v1",
        "reviewed_candidates": len(reviewed),
        "promotable_candidates": len(promotable),
        "rejected_candidates": len(rejected),
        "pending_candidates": len(pending),
        "reject_rate": None if reject_rate is None else round(reject_rate, 4),
        "facts": facts,
        "evidence_edges": edges,
        "pending_candidate_ids": pending,
        "rejected_candidate_ids": [candidate.get("candidate_id") for candidate in rejected],
        "reviewed_candidates_missing_rationale": missing_rationale,
        "promotable_candidates_missing_evidence": missing_evidence,
        "failures": failures,
    }


def main() -> int:
    args = parse_args()
    plan = create_promotion_plan(load_json(args.review))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, indent=2) + "\n")
    if args.json:
        print(json.dumps(plan, indent=2))
    else:
        print("graph promotion plan")
        print(f"reviewed candidates: {plan['reviewed_candidates']}")
        print(f"promotable candidates: {plan['promotable_candidates']}")
        print(f"pending candidates: {plan['pending_candidates']}")
        print(f"facts: {len(plan['facts'])}")
        print(f"evidence edges: {len(plan['evidence_edges'])}")
        print(f"reject rate: {plan['reject_rate']}")
        print(f"failures: {plan['failures']}")
        print(f"out: {out}")
    return 1 if plan["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
