#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from statistics import mean
from typing import Any


LABEL_ACTIONS = {
    "approval": {
        "candidate_id": "section_candidate:approval_checkpoint",
        "proposed_action": "record_approval_checkpoint",
        "note": "Lifecycle/support evidence; not a standalone workflow section type yet.",
    },
    "correction_or_rejection_signal": {
        "candidate_id": "section_candidate:correction_loop",
        "proposed_action": "add_context_guardrail",
        "note": "Correction or rejection signal that may explain future agent steering.",
    },
    "environment_or_preference_signal": {
        "candidate_id": "section_candidate:preference_discovery",
        "proposed_action": "record_guidance_or_environment_preference",
        "note": "User preference, tooling direction, or environment constraint.",
    },
    "verification_or_recovery_signal": {
        "candidate_id": "section_candidate:verification_loop",
        "proposed_action": "add_verification_gate",
        "note": "Verification request, benchmark, recovery, or quality gate.",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate graph-usefulness of a gated SetFit classifier report.")
    parser.add_argument("--gate-stack", default=".ax/experiments/setfit-gate-stack-robustness-e152-combined119-pair-group-repeated.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-e58-with-accepted-hard-negatives.jsonl")
    parser.add_argument("--out", default=".ax/experiments/setfit-gate-stack-usefulness-e153-combined119.json")
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


def candidate_metadata(label: str) -> dict[str, str]:
    return LABEL_ACTIONS.get(label, {
        "candidate_id": f"section_candidate:{label}",
        "proposed_action": "review_section_pattern",
        "note": "Unknown positive label; requires manual graph modeling review.",
    })


def compact_text(text: str, limit: int = 180) -> str:
    squashed = " ".join(text.split())
    if len(squashed) <= limit:
        return squashed
    return squashed[: limit - 1].rstrip() + "..."


def positive_examples(examples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [example for example in examples if str(example.get("predicted")) != "none"]


def group_candidates(examples: list[dict[str, Any]], fixtures: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for example in positive_examples(examples):
        predicted = str(example["predicted"])
        metadata = candidate_metadata(predicted)
        group = groups.setdefault(predicted, {
            "label": predicted,
            **metadata,
            "support_count": 0,
            "true_positive_count": 0,
            "wrong_family_count": 0,
            "fixture_evidence_count": 0,
            "source_groups": {},
            "example_ids": [],
            "examples": [],
        })
        row_id = str(example["id"])
        fixture = fixtures.get(row_id)
        group["support_count"] += 1
        group["true_positive_count"] += 1 if str(example["actual"]) == predicted else 0
        group["wrong_family_count"] += 1 if str(example["actual"]) not in (predicted, "none") else 0
        group["fixture_evidence_count"] += 1 if fixture and str(fixture.get("text") or "").strip() else 0
        if fixture:
            source_group = str(fixture.get("source_group") or "unknown")
            group["source_groups"][source_group] = int(group["source_groups"].get(source_group, 0)) + 1
        if len(group["example_ids"]) < 8:
            group["example_ids"].append(row_id)
        if len(group["examples"]) < 3:
            group["examples"].append({
                "id": row_id,
                "actual": str(example["actual"]),
                "predicted": predicted,
                "source_group": fixture.get("source_group") if fixture else None,
                "text_excerpt": compact_text(str(fixture.get("text") or "")) if fixture else "",
            })
    return [
        {**group, "source_groups": dict(sorted(group["source_groups"].items()))}
        for _, group in sorted(groups.items())
    ]


def run_metrics(run: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    examples = list(run.get("examples") or [])
    positives = positive_examples(examples)
    graph_noise = [
        example for example in positives
        if str(example.get("actual")) == "none"
    ]
    missed_signals = [
        example for example in examples
        if str(example.get("actual")) != "none" and str(example.get("predicted")) == "none"
    ]
    wrong_family = [
        example for example in positives
        if str(example.get("actual")) not in (str(example.get("predicted")), "none")
    ]
    accepted_hard_negative_misses = [
        example for example in positives
        if str((fixtures.get(str(example.get("id"))) or {}).get("source_group")) == "blind-hard-negative"
    ]
    evidence_backed = [
        example for example in positives
        if str((fixtures.get(str(example.get("id"))) or {}).get("text") or "").strip()
    ]
    evidence_coverage = len(evidence_backed) / len(positives) if positives else 1.0
    candidates = group_candidates(examples, fixtures)
    return {
        "seed": run.get("seed"),
        "test_rows": len(examples),
        "predicted_positive_count": len(positives),
        "model_assisted_candidate_count": len(candidates),
        "fixture_evidence_coverage": round(evidence_coverage, 4),
        "graph_noise_count": len(graph_noise),
        "missed_signal_count": len(missed_signals),
        "wrong_family_count": len(wrong_family),
        "accepted_hard_negative_miss_count": len(accepted_hard_negative_misses),
        "candidate_groups": candidates,
        "graph_noise_ids": [str(example["id"]) for example in graph_noise],
        "missed_signal_ids": [str(example["id"]) for example in missed_signals],
        "wrong_family_ids": [str(example["id"]) for example in wrong_family],
        "accepted_hard_negative_miss_ids": [str(example["id"]) for example in accepted_hard_negative_misses],
    }


def summarize_runs(runs: list[dict[str, Any]], source_decision: str | None) -> dict[str, Any]:
    predicted_positive_counts = [int(run["predicted_positive_count"]) for run in runs]
    candidate_counts = [int(run["model_assisted_candidate_count"]) for run in runs]
    evidence_coverages = [float(run["fixture_evidence_coverage"]) for run in runs]
    graph_noise_total = sum(int(run["graph_noise_count"]) for run in runs)
    hard_negative_miss_total = sum(int(run["accepted_hard_negative_miss_count"]) for run in runs)
    missed_signal_total = sum(int(run["missed_signal_count"]) for run in runs)
    wrong_family_total = sum(int(run["wrong_family_count"]) for run in runs)
    failures = []
    if source_decision != "candidate_robust_gate_stack":
        failures.append("source gate-stack report is not a robust candidate")
    if graph_noise_total > 0:
        failures.append("gated predictions would add graph noise from none rows")
    if hard_negative_miss_total > 0:
        failures.append("accepted hard negatives would become positive graph candidates")
    if min(candidate_counts) < 3:
        failures.append("less than 3 candidate groups in at least one run")
    if min(evidence_coverages) < 1.0:
        failures.append("not every positive candidate has fixture text evidence")
    return {
        "runs": len(runs),
        "predicted_positive_count_mean": round(mean(predicted_positive_counts), 4),
        "predicted_positive_count_min": min(predicted_positive_counts),
        "model_assisted_candidate_count_mean": round(mean(candidate_counts), 4),
        "model_assisted_candidate_count_min": min(candidate_counts),
        "fixture_evidence_coverage_mean": round(mean(evidence_coverages), 4),
        "fixture_evidence_coverage_min": round(min(evidence_coverages), 4),
        "graph_noise_count_total": graph_noise_total,
        "accepted_hard_negative_miss_count_total": hard_negative_miss_total,
        "missed_signal_count_total": missed_signal_total,
        "wrong_family_count_total": wrong_family_total,
        "failures": failures,
    }


def build_report(gate_stack_report: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    runs = [run_metrics(run, fixtures) for run in list(gate_stack_report.get("runs") or [])]
    if not runs:
        raise ValueError("gate-stack report has no runs")
    summary = summarize_runs(runs, gate_stack_report.get("decision"))
    return {
        "schema": "ax.setfit_gate_stack_graph_usefulness_report.v1",
        "source_schema": gate_stack_report.get("schema"),
        "source_decision": gate_stack_report.get("decision"),
        "source_summary": gate_stack_report.get("summary"),
        "summary": summary,
        "runs": runs,
        "manual_review_reject_rate": None,
        "manual_review_note": "Fixture-backed graph usefulness smoke only; production graph facts still need persisted evidence refs and review gates.",
        "decision": "candidate_graph_usefulness" if not summary["failures"] else "needs_graph_usefulness_work",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.gate_stack), load_fixture_index(args.fixtures))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        summary = report["summary"]
        print("gate-stack graph usefulness report")
        print(f"runs: {summary['runs']}")
        print(f"candidate groups min: {summary['model_assisted_candidate_count_min']}")
        print(f"positive predictions mean: {summary['predicted_positive_count_mean']}")
        print(f"fixture evidence coverage min: {summary['fixture_evidence_coverage_min']}")
        print(f"graph noise total: {summary['graph_noise_count_total']}")
        print(f"accepted hard-negative misses: {summary['accepted_hard_negative_miss_count_total']}")
        print(f"decision: {report['decision']}")
        if summary["failures"]:
            print(f"failures: {summary['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "candidate_graph_usefulness" else 1


if __name__ == "__main__":
    raise SystemExit(main())
