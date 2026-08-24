#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate model-assisted section graph usefulness from E4/E5 artifacts.")
    parser.add_argument("--hybrid", default=".ax/experiments/hybrid-gate-e4.json")
    parser.add_argument("--sections", default=".ax/experiments/session-section-assembly-e5.json")
    parser.add_argument("--out", default=".ax/experiments/graph-usefulness-e6.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def section_candidates(section_report: dict[str, Any]) -> list[dict[str, Any]]:
    counts = section_report.get("predicted_type_counts") or {}
    return [
        {
            "candidate_id": f"section_candidate:{section_type}",
            "section_type": section_type,
            "sections": int(count),
            "proposed_action": action_for_section(section_type),
        }
        for section_type, count in sorted(counts.items())
    ]


def action_for_section(section_type: str) -> str:
    if section_type == "preference_discovery":
        return "record_guidance_or_environment_preference"
    if section_type == "correction_loop":
        return "add_context_guardrail"
    if section_type == "verification_loop":
        return "add_verification_gate"
    return "review_section_pattern"


def evaluate_usefulness(hybrid: dict[str, Any], sections: dict[str, Any]) -> dict[str, Any]:
    candidates = section_candidates(sections)
    model_only_positive_count = int(hybrid.get("model_only_positive_count") or 0)
    deterministic_positive_count = int(hybrid.get("deterministic_positive_count") or 0)
    section_count = int(sections.get("predicted_sections") or 0)
    evidence_coverage = float(sections.get("evidence_coverage") or 0.0)
    model_only_evidence_coverage = float(hybrid.get("model_only_evidence_coverage") or 0.0)
    candidate_count = len(candidates)
    model_assisted_candidate_count = sum(1 for candidate in candidates if int(candidate["sections"]) > 0)
    useful_new_fact_rate = float(hybrid.get("useful_new_fact_rate") or 0.0)
    failures = []
    if model_assisted_candidate_count < 3:
        failures.append("less than 3 model-assisted candidate groups")
    if evidence_coverage < 0.90:
        failures.append("section evidence coverage below 90%")
    if model_only_evidence_coverage < 1.0:
        failures.append("model-only evidence coverage below 100%")
    if useful_new_fact_rate < 0.10:
        failures.append("useful new fact rate below 10%")
    if section_count == 0:
        failures.append("no assembled sections")
    return {
        "deterministic_positive_count": deterministic_positive_count,
        "model_only_positive_count": model_only_positive_count,
        "useful_new_fact_rate": round(useful_new_fact_rate, 4),
        "section_count": section_count,
        "section_evidence_coverage": round(evidence_coverage, 4),
        "model_only_evidence_coverage": round(model_only_evidence_coverage, 4),
        "candidate_count": candidate_count,
        "model_assisted_candidate_count": model_assisted_candidate_count,
        "candidate_groups": candidates,
        "manual_review_reject_rate": None,
        "manual_review_note": "No human review captured yet; treat this as pre-review graph usefulness smoke.",
        "failures": failures,
    }


def main() -> int:
    args = parse_args()
    report = evaluate_usefulness(load_json(args.hybrid), load_json(args.sections))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("graph usefulness smoke report")
        print(f"deterministic positives: {report['deterministic_positive_count']}")
        print(f"model-only positives: {report['model_only_positive_count']}")
        print(f"useful new fact rate: {report['useful_new_fact_rate']}")
        print(f"sections: {report['section_count']}")
        print(f"section evidence coverage: {report['section_evidence_coverage']}")
        print(f"candidate groups: {report['model_assisted_candidate_count']}")
        print(f"manual review reject rate: {report['manual_review_reject_rate']}")
        print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
