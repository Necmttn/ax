#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare two workflow-candidate reports by source kind.")
    parser.add_argument("--baseline", default=".ax/experiments/workflow-candidate-report-e156.json")
    parser.add_argument("--candidate", default=".ax/experiments/workflow-candidate-report-hybrid-window-current.json")
    parser.add_argument("--out", default=".ax/experiments/workflow-candidate-compare-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def labels(report: dict[str, Any]) -> set[str]:
    return {str(candidate.get("label") or "") for candidate in report.get("candidates") or []}


def actions(report: dict[str, Any]) -> set[str]:
    return {str(candidate.get("proposed_action") or "") for candidate in report.get("candidates") or []}


def totals(report: dict[str, Any]) -> dict[str, int]:
    raw = report.get("totals") or {}
    return {
        "candidate_group_count": int(raw.get("candidate_group_count") or 0),
        "returned_candidate_count": int(raw.get("returned_candidate_count") or 0),
        "evidence_fact_count": int(raw.get("evidence_fact_count") or 0),
        "candidate_with_evidence_count": int(raw.get("candidate_with_evidence_count") or 0),
        "wrapper_like_count": int(raw.get("wrapper_like_count") or 0),
        "task_like_count": int(raw.get("task_like_count") or 0),
    }


def build_report(baseline: dict[str, Any], candidate: dict[str, Any], baseline_path: str, candidate_path: str) -> dict[str, Any]:
    baseline_totals = totals(baseline)
    candidate_totals = totals(candidate)
    baseline_labels = labels(baseline)
    candidate_labels = labels(candidate)
    baseline_actions = actions(baseline)
    candidate_actions = actions(candidate)
    failures = []
    if baseline.get("decision") != "workflow_candidates_ranked":
        failures.append("baseline workflow report is not ranked")
    if candidate.get("decision") != "workflow_candidates_ranked":
        failures.append("candidate workflow report is not ranked")
    if candidate_totals["candidate_group_count"] < 3:
        failures.append("candidate source has fewer than 3 workflow candidate groups")
    if candidate_totals["candidate_with_evidence_count"] != candidate_totals["candidate_group_count"]:
        failures.append("candidate source has workflow groups without evidence")
    if candidate_totals["wrapper_like_count"] > 0:
        failures.append("candidate source has wrapper-like evidence")
    if not candidate_actions:
        failures.append("candidate source has no proposed graph actions")
    return {
        "schema": "ax.workflow_candidate_source_compare.v1",
        "baseline": {
            "path": baseline_path,
            "source_kind": baseline.get("source_kind"),
            "decision": baseline.get("decision"),
            "totals": baseline_totals,
            "labels": sorted(baseline_labels),
            "actions": sorted(baseline_actions),
        },
        "candidate": {
            "path": candidate_path,
            "source_kind": candidate.get("source_kind"),
            "decision": candidate.get("decision"),
            "totals": candidate_totals,
            "labels": sorted(candidate_labels),
            "actions": sorted(candidate_actions),
        },
        "delta": {
            "candidate_group_count": candidate_totals["candidate_group_count"] - baseline_totals["candidate_group_count"],
            "evidence_fact_count": candidate_totals["evidence_fact_count"] - baseline_totals["evidence_fact_count"],
            "new_labels": sorted(candidate_labels - baseline_labels),
            "shared_labels": sorted(candidate_labels & baseline_labels),
            "missing_baseline_labels": sorted(baseline_labels - candidate_labels),
            "new_actions": sorted(candidate_actions - baseline_actions),
            "shared_actions": sorted(candidate_actions & baseline_actions),
        },
        "failures": failures,
        "decision": "workflow_candidate_sources_compared" if not failures else "needs_workflow_candidate_source_review",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.baseline), load_json(args.candidate), args.baseline, args.candidate)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("workflow candidate source compare")
        print(f"decision: {report['decision']}")
        print(f"baseline groups: {report['baseline']['totals']['candidate_group_count']}")
        print(f"candidate groups: {report['candidate']['totals']['candidate_group_count']}")
        print(f"candidate evidence facts: {report['candidate']['totals']['evidence_fact_count']}")
        print(f"shared actions: {', '.join(report['delta']['shared_actions'])}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "workflow_candidate_sources_compared" else 1


if __name__ == "__main__":
    raise SystemExit(main())
