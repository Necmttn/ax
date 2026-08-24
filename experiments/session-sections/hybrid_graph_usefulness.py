#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from statistics import mean
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gate_stack_usefulness import load_fixture_index, run_metrics  # noqa: E402
from none_safety_pregate import load_json, source_examples  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare baseline SetFit and hybrid classifier outputs as graph-ready candidates.")
    parser.add_argument("--robustness", default=".ax/experiments/setfit-robustness-workflow-fixtures-current.json")
    parser.add_argument("--hybrid", default=".ax/experiments/hybrid-robustness-workflow-fixtures-current.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-with-workflow-fixture-metadata-current.jsonl")
    parser.add_argument("--out", default=".ax/experiments/hybrid-graph-usefulness-workflow-fixtures-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def indexed_runs(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(run.get("seed")): run for run in list(report.get("runs") or [])}


def graph_noise_ids(metrics: dict[str, Any]) -> set[str]:
    return {str(row_id) for row_id in metrics.get("graph_noise_ids") or []}


def positive_ids(metrics: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for group in metrics.get("candidate_groups") or []:
        ids.update(str(row_id) for row_id in group.get("example_ids") or [])
    return ids


def run_comparison(
    seed: str,
    baseline_run: dict[str, Any],
    hybrid_run: dict[str, Any],
    fixtures: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    baseline_metrics = run_metrics({"seed": seed, "examples": source_examples(baseline_run)}, fixtures)
    hybrid_metrics = run_metrics({"seed": seed, "examples": list(hybrid_run.get("examples") or [])}, fixtures)
    baseline_noise = graph_noise_ids(baseline_metrics)
    hybrid_noise = graph_noise_ids(hybrid_metrics)
    baseline_positive = positive_ids(baseline_metrics)
    hybrid_positive = positive_ids(hybrid_metrics)
    removed_noise = sorted(baseline_noise - hybrid_noise)
    introduced_noise = sorted(hybrid_noise - baseline_noise)
    removed_positive = sorted(baseline_positive - hybrid_positive)
    added_positive = sorted(hybrid_positive - baseline_positive)
    return {
        "seed": int(seed) if seed.isdigit() else seed,
        "baseline": baseline_metrics,
        "hybrid": hybrid_metrics,
        "removed_graph_noise_count": len(removed_noise),
        "removed_graph_noise_ids": removed_noise,
        "introduced_graph_noise_count": len(introduced_noise),
        "introduced_graph_noise_ids": introduced_noise,
        "removed_positive_count": len(removed_positive),
        "removed_positive_ids": removed_positive,
        "added_positive_count": len(added_positive),
        "added_positive_ids": added_positive,
    }


def summarize(comparisons: list[dict[str, Any]], hybrid_decision: str | None, harmful_overrides: int) -> dict[str, Any]:
    hybrid_candidate_counts = [int(run["hybrid"]["model_assisted_candidate_count"]) for run in comparisons]
    hybrid_evidence = [float(run["hybrid"]["fixture_evidence_coverage"]) for run in comparisons]
    baseline_noise_total = sum(int(run["baseline"]["graph_noise_count"]) for run in comparisons)
    hybrid_noise_total = sum(int(run["hybrid"]["graph_noise_count"]) for run in comparisons)
    removed_noise_total = sum(int(run["removed_graph_noise_count"]) for run in comparisons)
    introduced_noise_total = sum(int(run["introduced_graph_noise_count"]) for run in comparisons)
    failures = []
    if hybrid_decision != "hybrid_robust_enough":
        failures.append("hybrid robustness report is not ready")
    if harmful_overrides > 0:
        failures.append("hybrid robustness report has harmful overrides")
    if hybrid_noise_total > 0:
        failures.append("hybrid predictions would add graph noise from none rows")
    if introduced_noise_total > 0:
        failures.append("hybrid introduced new graph noise")
    if min(hybrid_candidate_counts) < 3:
        failures.append("less than 3 hybrid candidate groups in at least one run")
    if min(hybrid_evidence) < 1.0:
        failures.append("not every hybrid positive candidate has fixture text evidence")
    if baseline_noise_total > 0 and removed_noise_total == 0:
        failures.append("hybrid did not remove any baseline graph noise")
    return {
        "runs": len(comparisons),
        "baseline_graph_noise_count_total": baseline_noise_total,
        "hybrid_graph_noise_count_total": hybrid_noise_total,
        "removed_graph_noise_count_total": removed_noise_total,
        "introduced_graph_noise_count_total": introduced_noise_total,
        "hybrid_candidate_group_count_mean": round(mean(hybrid_candidate_counts), 4),
        "hybrid_candidate_group_count_min": min(hybrid_candidate_counts),
        "hybrid_fixture_evidence_coverage_mean": round(mean(hybrid_evidence), 4),
        "hybrid_fixture_evidence_coverage_min": round(min(hybrid_evidence), 4),
        "failures": failures,
    }


def build_report(
    robustness_report: dict[str, Any],
    hybrid_report: dict[str, Any],
    fixtures: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    baseline_by_seed = indexed_runs(robustness_report)
    hybrid_by_seed = indexed_runs(hybrid_report)
    missing = sorted(set(hybrid_by_seed) - set(baseline_by_seed))
    if missing:
        raise ValueError(f"hybrid seeds missing from robustness report: {', '.join(missing)}")
    comparisons = [
        run_comparison(seed, baseline_by_seed[seed], hybrid_by_seed[seed], fixtures)
        for seed in sorted(hybrid_by_seed)
    ]
    if not comparisons:
        raise ValueError("hybrid report has no runs")
    summary = summarize(
        comparisons,
        str(hybrid_report.get("decision") or ""),
        int(hybrid_report.get("harmful_override_count_total") or 0),
    )
    return {
        "schema": "ax.setfit_hybrid_graph_usefulness_report.v1",
        "source_schema": hybrid_report.get("schema"),
        "source_decision": hybrid_report.get("decision"),
        "source_summary": hybrid_report.get("summary"),
        "source_policy": hybrid_report.get("policy"),
        "baseline_source_schema": robustness_report.get("schema"),
        "baseline_source_decision": robustness_report.get("decision"),
        "summary": summary,
        "runs": comparisons,
        "manual_review_reject_rate": None,
        "manual_review_note": "Fixture-backed hybrid graph usefulness smoke only; production promotion still needs transcript evidence refs and review gates.",
        "decision": "hybrid_graph_usefulness_ready" if not summary["failures"] else "needs_hybrid_graph_usefulness_work",
    }


def main() -> int:
    args = parse_args()
    report = build_report(
        load_json(args.robustness),
        load_json(args.hybrid),
        load_fixture_index(args.fixtures),
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        summary = report["summary"]
        print("hybrid graph usefulness report")
        print(f"decision: {report['decision']}")
        print(f"hybrid candidate groups min: {summary['hybrid_candidate_group_count_min']}")
        print(f"hybrid evidence coverage min: {summary['hybrid_fixture_evidence_coverage_min']}")
        print(f"baseline graph noise: {summary['baseline_graph_noise_count_total']}")
        print(f"hybrid graph noise: {summary['hybrid_graph_noise_count_total']}")
        print(f"removed graph noise: {summary['removed_graph_noise_count_total']}")
        if summary["failures"]:
            print(f"failures: {summary['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "hybrid_graph_usefulness_ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
