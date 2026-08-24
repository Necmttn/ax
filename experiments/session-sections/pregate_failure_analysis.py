#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from failure_analysis import compact_text, confusion_family, family_counts  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze remaining misses after deterministic none pre-gate overrides.")
    parser.add_argument("--two-stage", default=".ax/experiments/setfit-two-stage-e39-pair-group-seed7.json")
    parser.add_argument("--pregate", default=".ax/experiments/setfit-two-stage-pregate-e41-pair-group-seed7.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl")
    parser.add_argument("--out", default=".ax/experiments/setfit-two-stage-pregate-failure-analysis-e42.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def load_fixture_index(path: str) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        rows[str(row["id"])] = row
    return rows


def apply_overrides(examples: list[dict[str, Any]], overrides: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {str(override["id"]): str(override["reason"]) for override in overrides}
    final = []
    for example in examples:
        row_id = str(example["id"])
        reason = by_id.get(row_id)
        final.append({
            "id": row_id,
            "actual": str(example["actual"]),
            "predicted": "none" if reason else str(example["predicted"]),
            "override_reason": reason,
        })
    return final


def misses(final_examples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        example
        for example in final_examples
        if example["actual"] != example["predicted"]
    ]


def pair_counts(misses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[tuple[str, str], int] = {}
    for miss in misses:
        key = (str(miss["actual"]), str(miss["predicted"]))
        counts[key] = counts.get(key, 0) + 1
    return [
        {"actual": actual, "predicted": predicted, "count": count}
        for (actual, predicted), count in sorted(counts.items(), key=lambda item: (-item[1], item[0][0], item[0][1]))
    ]


def enrich_misses(misses: list[dict[str, Any]], fixtures: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    enriched = []
    for miss in misses:
        fixture = fixtures.get(str(miss["id"]), {})
        enriched.append({
            **miss,
            "family": confusion_family(str(miss["actual"]), str(miss["predicted"])),
            "fine_label": fixture.get("label"),
            "target": fixture.get("target"),
            "boundary_group": fixture.get("boundary_group"),
            "pair_group": fixture.get("pair_group"),
            "text_excerpt": compact_text(str(fixture.get("text") or "")),
        })
    return enriched


def recommended_next_actions(enriched_misses: list[dict[str, Any]]) -> list[str]:
    recommendations = []
    pairs = pair_counts(enriched_misses)
    if any(pair["actual"] == "approval" and pair["predicted"] == "verification_or_recovery_signal" for pair in pairs):
        recommendations.append("Add or gate approval-resume examples that should not become verification/recovery.")
    if any(pair["actual"] == "correction_or_rejection_signal" and pair["predicted"] == "environment_or_preference_signal" for pair in pairs):
        recommendations.append("Add correction-vs-environment contrast examples for workflow-state and cost objections.")
    if any(pair["actual"] == "environment_or_preference_signal" and pair["predicted"] == "none" for pair in pairs):
        recommendations.append("Protect dev-environment/tooling requests from abstaining to none.")
    recommendations.append("Keep the deterministic none pre-gate in the candidate stack, but do not promote until family macro F1 passes.")
    return recommendations


def build_report(two_stage_report: dict[str, Any], pregate_report: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if len(two_stage_report.get("runs") or []) != 1:
        raise ValueError("pregate failure analysis expects a single two-stage run")
    examples = list(two_stage_report["runs"][0]["examples"])
    final = apply_overrides(examples, list(pregate_report.get("overrides") or []))
    remaining = enrich_misses(misses(final), fixtures)
    return {
        "schema": "ax.setfit_two_stage_pregate_failure_analysis.v1",
        "source_report": {
            "two_stage_summary": two_stage_report.get("summary"),
            "pregate_metrics": pregate_report.get("metrics"),
            "pregate_decision": pregate_report.get("decision"),
            "overrides": pregate_report.get("overrides") or [],
        },
        "remaining_miss_count": len(remaining),
        "remaining_misses": remaining,
        "pair_counts": pair_counts(remaining),
        "family_counts": family_counts(remaining),
        "recommended_next_actions": recommended_next_actions(remaining),
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.two_stage), load_json(args.pregate), load_fixture_index(args.fixtures))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit pre-gate failure analysis")
        print(f"remaining misses: {report['remaining_miss_count']}")
        print(f"families: {report['family_counts']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
