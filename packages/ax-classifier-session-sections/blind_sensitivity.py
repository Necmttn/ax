#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_gate_eval import build_report as build_gate_report  # noqa: E402
from blind_gate_eval import load_jsonl  # noqa: E402
from blind_label_review import load_json, write_json  # noqa: E402


SCENARIOS = [
    "accept_suggestions",
    "high_risk_environment_to_none",
    "conservative_risk_to_none",
]

HIGH_RISK_ENV_REASONS = {
    "environment_overprediction_risk",
    "context_dump",
    "possible_none_control_turn",
}

CONSERVATIVE_RISK_REASONS = {
    "environment_overprediction_risk",
    "context_dump",
    "possible_none_control_turn",
    "low_confidence",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run synthetic-label sensitivity scenarios for the blind gate stack.")
    parser.add_argument("--review", default=".ax/experiments/blind-session-section-label-review-e49.json")
    parser.add_argument("--suggestions", default=".ax/experiments/blind-session-section-label-suggestions-e51.json")
    parser.add_argument("--priorities", default=".ax/experiments/blind-session-section-review-priority-e52.json")
    parser.add_argument("--predictions", default=".ax/experiments/blind-session-section-predictions-e48.jsonl")
    parser.add_argument("--out", default=".ax/experiments/blind-sensitivity-e53.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def by_id(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(row.get("id")): row for row in rows}


def scenario_label(scenario: str, suggestion: dict[str, Any], priority: dict[str, Any]) -> str:
    label = str(suggestion.get("suggested_label") or "none")
    reasons = set(str(reason) for reason in priority.get("risk_reasons", []))
    if scenario == "accept_suggestions":
        return label
    if scenario == "high_risk_environment_to_none":
        if label == "environment_or_preference_signal" and reasons.intersection(HIGH_RISK_ENV_REASONS):
            return "none"
        return label
    if scenario == "conservative_risk_to_none":
        if reasons.intersection(CONSERVATIVE_RISK_REASONS):
            return "none"
        return label
    raise ValueError(f"unknown sensitivity scenario: {scenario}")


def scenario_target(label: str, suggestion: dict[str, Any]) -> str:
    return str(suggestion.get("suggested_target") or label)


def synthetic_rows(
    review: dict[str, Any],
    suggestions: dict[str, Any],
    priorities: dict[str, Any],
    scenario: str,
) -> list[dict[str, Any]]:
    suggestions_by_id = by_id(list(suggestions.get("items", [])))
    priorities_by_id = by_id(list(priorities.get("items", [])))
    rows: list[dict[str, Any]] = []
    for item in review.get("items", []):
        item_id = str(item.get("id"))
        suggestion = suggestions_by_id.get(item_id, {})
        priority = priorities_by_id.get(item_id, {})
        label = scenario_label(scenario, suggestion, priority)
        row = dict(item)
        row["label"] = label
        row["target"] = scenario_target(label, suggestion)
        row["review_notes"] = f"synthetic sensitivity label from {scenario}; not human-reviewed"
        row["synthetic_label_source"] = scenario
        row["synthetic_risk_reasons"] = list(priority.get("risk_reasons", []))
        rows.append(row)
    return rows


def summarize_scenario(scenario: str, gate_report: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "scenario": scenario,
        "synthetic_label_counts": dict(sorted(Counter(str(row.get("label")) for row in rows).items())),
        "metrics": gate_report.get("metrics", {}),
        "unsafe_none_miss_count": gate_report.get("unsafe_none_miss_count"),
        "remaining_miss_count": gate_report.get("remaining_miss_count"),
        "remaining_pair_counts": gate_report.get("remaining_pair_counts", {}),
        "decision": gate_report.get("decision"),
    }


def run_scenarios(
    review: dict[str, Any],
    suggestions: dict[str, Any],
    priorities: dict[str, Any],
    predictions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []
    for scenario in SCENARIOS:
        rows = synthetic_rows(review, suggestions, priorities, scenario)
        gate_report = build_gate_report(rows, predictions)
        reports.append(summarize_scenario(scenario, gate_report, rows))
    return reports


def build_report(scenario_reports: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "schema": "ax.blind_sensitivity.v1",
        "blind_eval": False,
        "warning": "Uses synthetic labels from suggestions/risk scenarios; do not treat as blind accuracy.",
        "scenarios": scenario_reports,
        "decision": "ready_for_human_label_comparison",
    }


def main() -> int:
    args = parse_args()
    report = build_report(run_scenarios(
        load_json(args.review),
        load_json(args.suggestions),
        load_json(args.priorities),
        load_jsonl(args.predictions),
    ))
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind sensitivity report")
        print("blind eval: false")
        for scenario in report["scenarios"]:
            metrics = scenario.get("metrics", {})
            print(
                f"{scenario['scenario']}: macro_f1={metrics.get('macro_f1')} "
                f"accuracy={metrics.get('accuracy')} unsafe_none={scenario.get('unsafe_none_miss_count')} "
                f"decision={scenario.get('decision')}"
            )
        print(f"out: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
