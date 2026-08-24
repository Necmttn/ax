#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


VALID_VERDICTS = {"accept", "revise", "reject", "pending"}

REVIEW_CRITERIA_BY_SECTION = {
    "correction_loop": [
        "Accept if examples show recurring user correction or rejection that should change future agent behavior.",
        "Revise if the signal is real but proposed action is too broad or should be split by cause.",
        "Reject if examples are ordinary task iteration without durable correction value.",
    ],
    "preference_discovery": [
        "Accept if examples reveal durable workflow, environment, tooling, or output preferences.",
        "Revise if examples mix unrelated preference types that should become separate candidates.",
        "Reject if examples are one-off task instructions without future reuse value.",
    ],
    "verification_loop": [
        "Accept if examples show recurring need for tests, proof, regression checks, or output verification.",
        "Revise if the candidate should distinguish proof requested by user from recovery performed by agent.",
        "Reject if examples do not imply a reusable verification gate.",
    ],
}

DEFAULT_REVIEW_CRITERIA = [
    "Accept if examples show a reusable, evidence-backed pattern that should affect future graph queries or harnesses.",
    "Revise if the pattern is useful but the proposed action or grouping is too broad.",
    "Reject if examples are noisy, one-off, or not useful for future agent behavior.",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate or evaluate manual review for model-assisted section candidates.")
    parser.add_argument("--graph", default=".ax/experiments/graph-usefulness-e6.json")
    parser.add_argument("--sections", default=".ax/experiments/session-section-assembly-e5.json")
    parser.add_argument("--review", default=".ax/experiments/graph-usefulness-review.json")
    parser.add_argument("--brief", default=".ax/experiments/graph-usefulness-review.md")
    parser.add_argument("--out", default=".ax/experiments/graph-usefulness-review-report.json")
    parser.add_argument("--mode", choices=["generate", "evaluate", "sync"], default="generate")
    parser.add_argument("--examples-per-candidate", type=int, default=3)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def section_examples_by_type(sections: dict[str, Any], limit: int) -> dict[str, list[dict[str, Any]]]:
    examples: dict[str, list[dict[str, Any]]] = {}
    for report in sections.get("session_reports", []):
        session = report.get("session")
        for predicted in report.get("predicted", []):
            section_type = str(predicted.get("section_type"))
            section_examples = examples.setdefault(section_type, [])
            if len(section_examples) >= limit:
                continue
            section_examples.append({
                "session": session,
                "start_seq": predicted.get("start_seq"),
                "end_seq": predicted.get("end_seq"),
                "labels": predicted.get("labels", []),
                "evidence": predicted.get("evidence", []),
            })
    return examples


def generate_review(
    graph: dict[str, Any],
    sections: dict[str, Any] | None = None,
    examples_per_candidate: int = 3,
) -> dict[str, Any]:
    examples = section_examples_by_type(sections or {}, examples_per_candidate)
    return {
        "schema": "ax.model_section_candidate_review.v1",
        "instructions": "Set each verdict to accept, revise, or reject after checking the examples. Leave pending until a human has reviewed the candidate group.",
        "candidates": [
            {
                "candidate_id": candidate["candidate_id"],
                "section_type": candidate["section_type"],
                "sections": candidate["sections"],
                "proposed_action": candidate["proposed_action"],
                "review_criteria": REVIEW_CRITERIA_BY_SECTION.get(candidate["section_type"], DEFAULT_REVIEW_CRITERIA),
                "examples": examples.get(candidate["section_type"], []),
                "verdict": "pending",
                "rationale": "",
            }
            for candidate in graph.get("candidate_groups", [])
        ],
    }


def example_has_evidence(example: dict[str, Any]) -> bool:
    return bool(example.get("evidence"))


def candidate_has_review_context(candidate: dict[str, Any]) -> bool:
    examples = candidate.get("examples") or []
    return bool(examples) and any(example_has_evidence(example) for example in examples)


def evaluate_review(review: dict[str, Any]) -> dict[str, Any]:
    candidates = review.get("candidates") or []
    invalid = [
        candidate.get("candidate_id")
        for candidate in candidates
        if str(candidate.get("verdict")) not in VALID_VERDICTS
    ]
    missing_examples = [
        candidate.get("candidate_id")
        for candidate in candidates
        if not candidate.get("examples")
    ]
    missing_evidence = [
        candidate.get("candidate_id")
        for candidate in candidates
        if candidate.get("examples") and not any(example_has_evidence(example) for example in candidate.get("examples", []))
    ]
    reviewed = [candidate for candidate in candidates if str(candidate.get("verdict")) in {"accept", "revise", "reject"}]
    rejected = [candidate for candidate in reviewed if str(candidate.get("verdict")) == "reject"]
    pending = [candidate for candidate in candidates if str(candidate.get("verdict")) == "pending"]
    missing_rationale = [
        candidate.get("candidate_id")
        for candidate in reviewed
        if not str(candidate.get("rationale") or "").strip()
    ]
    reviewable = [candidate for candidate in candidates if candidate_has_review_context(candidate)]
    reject_rate = len(rejected) / len(reviewed) if reviewed else None
    failures = []
    if invalid:
        failures.append("review contains invalid verdicts")
    if missing_examples:
        failures.append("review candidates are missing examples")
    if missing_evidence:
        failures.append("review candidates are missing evidence-backed examples")
    if pending:
        failures.append("review still has pending candidates")
    if missing_rationale:
        failures.append("reviewed candidates are missing rationales")
    if reject_rate is None:
        failures.append("no reviewed candidates")
    elif reject_rate >= 0.30:
        failures.append("manual review reject rate is not below 30%")
    return {
        "candidates": len(candidates),
        "reviewable": len(reviewable),
        "reviewed": len(reviewed),
        "pending": len(pending),
        "rejected": len(rejected),
        "reject_rate": None if reject_rate is None else round(reject_rate, 4),
        "invalid_candidates": invalid,
        "candidates_missing_examples": missing_examples,
        "candidates_missing_evidence": missing_evidence,
        "reviewed_candidates_missing_rationale": missing_rationale,
        "failures": failures,
    }


def render_markdown_brief(review: dict[str, Any]) -> str:
    lines = [
        "# Graph Usefulness Candidate Review",
        "",
        review.get("instructions", ""),
        "",
    ]
    for candidate in review.get("candidates", []):
        lines.extend([
            f"## {candidate.get('candidate_id')}",
            "",
            f"- Section type: `{candidate.get('section_type')}`",
            f"- Sections: `{candidate.get('sections')}`",
            f"- Proposed action: `{candidate.get('proposed_action')}`",
            f"- Verdict: `{candidate.get('verdict')}`",
            f"- Rationale: {candidate.get('rationale') or '_pending_'}",
            "",
            "Review criteria:",
            "",
        ])
        for criterion in candidate.get("review_criteria", []):
            lines.append(f"- {criterion}")
        lines.extend([
            "",
            "Examples:",
            "",
        ])
        for example in candidate.get("examples", []):
            labels = ", ".join(f"`{label}`" for label in example.get("labels", [])) or "_none_"
            evidence = ", ".join(f"`{ref}`" for ref in example.get("evidence", [])) or "_none_"
            lines.extend([
                f"- `{example.get('session')}` seq `{example.get('start_seq')}`-`{example.get('end_seq')}`",
                f"  Labels: {labels}",
                f"  Evidence: {evidence}",
            ])
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


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
        if line.startswith("## "):
            current_id = line.removeprefix("## ").strip()
            updates.setdefault(current_id, {})
            continue
        if current_id is None:
            continue
        verdict_match = re.match(r"- Verdict:\s*(.+)$", line)
        if verdict_match:
            updates[current_id]["verdict"] = strip_inline_code(verdict_match.group(1)).lower()
            continue
        rationale_match = re.match(r"- Rationale:\s*(.*)$", line)
        if rationale_match:
            rationale = rationale_match.group(1).strip()
            updates[current_id]["rationale"] = "" if rationale == "_pending_" else rationale
    return updates


def sync_review_from_markdown(review: dict[str, Any], brief: str) -> dict[str, Any]:
    updates = parse_markdown_review(brief)
    synced = dict(review)
    synced_candidates = []
    for candidate in review.get("candidates", []):
        synced_candidate = dict(candidate)
        candidate_updates = updates.get(str(candidate.get("candidate_id")), {})
        if "verdict" in candidate_updates:
            synced_candidate["verdict"] = candidate_updates["verdict"]
        if "rationale" in candidate_updates:
            synced_candidate["rationale"] = candidate_updates["rationale"]
        synced_candidates.append(synced_candidate)
    synced["candidates"] = synced_candidates
    return synced


def main() -> int:
    args = parse_args()
    if args.mode == "generate":
        review = generate_review(
            load_json(args.graph),
            load_json(args.sections),
            args.examples_per_candidate,
        )
        review_path = Path(args.review)
        review_path.parent.mkdir(parents=True, exist_ok=True)
        review_path.write_text(json.dumps(review, indent=2) + "\n")
        brief_path = Path(args.brief)
        brief_path.parent.mkdir(parents=True, exist_ok=True)
        brief_path.write_text(render_markdown_brief(review))
        report = evaluate_review(review)
    elif args.mode == "sync":
        review = sync_review_from_markdown(load_json(args.review), Path(args.brief).read_text())
        review_path = Path(args.review)
        review_path.parent.mkdir(parents=True, exist_ok=True)
        review_path.write_text(json.dumps(review, indent=2) + "\n")
        report = evaluate_review(review)
    else:
        report = evaluate_review(load_json(args.review))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("graph usefulness review report")
        print(f"candidates: {report['candidates']}")
        print(f"reviewable: {report['reviewable']}")
        print(f"reviewed: {report['reviewed']}")
        print(f"pending: {report['pending']}")
        print(f"rejected: {report['rejected']}")
        print(f"reject rate: {report['reject_rate']}")
        print(f"failures: {report['failures']}")
        print(f"review: {args.review}")
        if args.mode == "generate":
            print(f"brief: {args.brief}")
        if args.mode == "sync":
            print(f"synced from: {args.brief}")
        print(f"out: {out}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
