#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Summarize SetFit session-section classifier experiment artifacts.")
    parser.add_argument("--embedding", default=".ax/experiments/embedding-baseline-e2-expanded.json")
    parser.add_argument("--setfit", default=".ax/experiments/setfit-session-sections-e3.json")
    parser.add_argument("--setfit-coarse", default=".ax/experiments/setfit-session-sections-e3-coarse.json")
    parser.add_argument("--hybrid", default=".ax/experiments/hybrid-gate-e4.json")
    parser.add_argument("--sections", default=".ax/experiments/session-section-assembly-e5.json")
    parser.add_argument("--graph", default=".ax/experiments/graph-usefulness-e6.json")
    parser.add_argument("--review", default=".ax/experiments/graph-usefulness-review-report.json")
    parser.add_argument("--promotion", default=".ax/experiments/graph-promotion-plan.json")
    parser.add_argument("--out", default=".ax/experiments/session-section-experiment-summary.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def gate(name: str, passed: bool, metric: Any, target: str) -> dict[str, Any]:
    return {
        "name": name,
        "passed": passed,
        "metric": metric,
        "target": target,
    }


def summarize_artifacts(
    embedding: dict[str, Any],
    setfit: dict[str, Any],
    setfit_coarse: dict[str, Any],
    hybrid: dict[str, Any],
    sections: dict[str, Any],
    graph: dict[str, Any],
    review: dict[str, Any],
    promotion: dict[str, Any],
) -> dict[str, Any]:
    gates = [
        gate("embedding_none_false_positive_rate", float(embedding.get("none_false_positive_rate") or 0) < 0.10, embedding.get("none_false_positive_rate"), "< 0.10"),
        gate("fine_setfit_macro_f1", float(setfit.get("macro_f1") or 0) >= 0.75, setfit.get("macro_f1"), ">= 0.75"),
        gate("fine_setfit_none_false_positive_rate", float(setfit.get("none_false_positive_rate") or 0) < 0.10, setfit.get("none_false_positive_rate"), "< 0.10"),
        gate("coarse_setfit_macro_f1", float(setfit_coarse.get("macro_f1") or 0) >= 0.75, setfit_coarse.get("macro_f1"), ">= 0.75"),
        gate("hybrid_run_rate", float(hybrid.get("setfit_run_rate") or 0) < 0.40, hybrid.get("setfit_run_rate"), "< 0.40"),
        gate("hybrid_useful_new_fact_rate", float(hybrid.get("useful_new_fact_rate") or 0) >= 0.10, hybrid.get("useful_new_fact_rate"), ">= 0.10"),
        gate("hybrid_model_only_evidence_coverage", float(hybrid.get("model_only_evidence_coverage") or 0) >= 1.0, hybrid.get("model_only_evidence_coverage"), ">= 1.0"),
        gate("section_boundary_overlap", float(sections.get("boundary_overlap") or 0) >= 0.65, sections.get("boundary_overlap"), ">= 0.65"),
        gate("section_evidence_coverage", float(sections.get("evidence_coverage") or 0) >= 0.90, sections.get("evidence_coverage"), ">= 0.90"),
        gate("graph_candidate_groups", int(graph.get("model_assisted_candidate_count") or 0) >= 3, graph.get("model_assisted_candidate_count"), ">= 3"),
        gate("review_all_candidates_reviewable", int(review.get("reviewable") or 0) == int(review.get("candidates") or -1), review.get("reviewable"), "reviewable == candidates"),
        gate("review_all_candidates_reviewed", int(review.get("pending") or 0) == 0 and int(review.get("reviewed") or 0) > 0, {"reviewed": review.get("reviewed"), "pending": review.get("pending")}, "pending == 0 and reviewed > 0"),
        gate("review_reject_rate", review.get("reject_rate") is not None and float(review.get("reject_rate")) < 0.30, review.get("reject_rate"), "< 0.30"),
        gate("promotion_plan_ready", not promotion.get("failures") and int(promotion.get("promotable_candidates") or 0) > 0, {"promotable": promotion.get("promotable_candidates"), "failures": promotion.get("failures")}, "promotable > 0 and no failures"),
    ]
    failed = [item for item in gates if not item["passed"]]
    recommendation = "revise"
    if not failed:
        recommendation = "adopt"
    elif any(item["name"] in {"fine_setfit_macro_f1", "coarse_setfit_macro_f1"} for item in failed):
        recommendation = "revise"
    if any(item["name"] == "embedding_none_false_positive_rate" for item in failed):
        embedding_decision = "reject_plain_embedding_classifier"
    else:
        embedding_decision = "keep_embedding_baseline"
    return {
        "schema": "ax.session_section_experiment_summary.v1",
        "recommendation": recommendation,
        "embedding_decision": embedding_decision,
        "production_default": "deterministic_classifiers_only",
        "experimental_path": "local_model_hybrid_gate_plus_section_assembly",
        "gate_count": len(gates),
        "passed_gate_count": len(gates) - len(failed),
        "failed_gate_count": len(failed),
        "gates": gates,
        "remaining_blockers": [item["name"] for item in failed],
        "manual_review_status": {
            "candidates": review.get("candidates"),
            "reviewable": review.get("reviewable"),
            "reviewed": review.get("reviewed"),
            "pending": review.get("pending"),
            "reject_rate": review.get("reject_rate"),
            "failures": review.get("failures"),
        },
        "promotion_status": {
            "promotable_candidates": promotion.get("promotable_candidates"),
            "pending_candidates": promotion.get("pending_candidates"),
            "facts": len(promotion.get("facts") or []),
            "evidence_edges": len(promotion.get("evidence_edges") or []),
            "failures": promotion.get("failures"),
        },
    }


def main() -> int:
    args = parse_args()
    summary = summarize_artifacts(
        load_json(args.embedding),
        load_json(args.setfit),
        load_json(args.setfit_coarse),
        load_json(args.hybrid),
        load_json(args.sections),
        load_json(args.graph),
        load_json(args.review),
        load_json(args.promotion),
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2) + "\n")
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("session-section experiment summary")
        print(f"recommendation: {summary['recommendation']}")
        print(f"passed gates: {summary['passed_gate_count']}/{summary['gate_count']}")
        print(f"remaining blockers: {summary['remaining_blockers']}")
        print(f"production default: {summary['production_default']}")
        print(f"experimental path: {summary['experimental_path']}")
        print(f"out: {out}")
    return 1 if summary["remaining_blockers"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
