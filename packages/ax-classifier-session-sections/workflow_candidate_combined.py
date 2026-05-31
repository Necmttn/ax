#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Combine workflow-candidate reports by proposed action and source kind.")
    parser.add_argument("--baseline", default=".ax/experiments/workflow-candidate-report-e156.json")
    parser.add_argument("--hybrid", default=".ax/experiments/workflow-candidate-report-hybrid-window-current.json")
    parser.add_argument("--out", default=".ax/experiments/workflow-candidate-combined-current.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def source_summary(report: dict[str, Any], path: str) -> dict[str, Any]:
    totals = report.get("totals") or {}
    return {
        "path": path,
        "source_kind": report.get("source_kind"),
        "decision": report.get("decision"),
        "candidate_group_count": int(totals.get("candidate_group_count") or 0),
        "evidence_fact_count": int(totals.get("evidence_fact_count") or 0),
        "wrapper_like_count": int(totals.get("wrapper_like_count") or 0),
        "task_like_count": int(totals.get("task_like_count") or 0),
    }


def candidate_label(candidate: dict[str, Any]) -> str:
    return str(candidate.get("label") or candidate.get("classifier_label") or "unknown")


def action_rows(report: dict[str, Any], path: str) -> dict[str, dict[str, Any]]:
    source_kind = str(report.get("source_kind") or "unknown")
    rows: dict[str, dict[str, Any]] = {}
    for candidate in report.get("candidates") or []:
        action = str(candidate.get("proposed_action") or "review_section_pattern")
        row = rows.setdefault(action, {
            "source_kind": source_kind,
            "path": path,
            "support_count": 0,
            "evidence_fact_count": 0,
            "task_like_count": 0,
            "wrapper_like_count": 0,
            "labels": set(),
            "top_candidates": [],
        })
        support = int(candidate.get("support_count") or 0)
        evidence = int(candidate.get("evidence_count") or 0)
        row["support_count"] += support
        row["evidence_fact_count"] += evidence
        row["task_like_count"] += int(candidate.get("task_like_count") or 0)
        row["wrapper_like_count"] += int(candidate.get("wrapper_like_count") or 0)
        row["labels"].add(candidate_label(candidate))
        if len(row["top_candidates"]) < 5:
            row["top_candidates"].append({
                "label": candidate_label(candidate),
                "score": candidate.get("score"),
                "support_count": support,
                "evidence_count": evidence,
                "task_like_count": int(candidate.get("task_like_count") or 0),
            })
    return rows


def serialize_source_action(row: dict[str, Any] | None, source_kind: str) -> dict[str, Any]:
    if row is None:
        return {
            "source_kind": source_kind,
            "present": False,
            "support_count": 0,
            "evidence_fact_count": 0,
            "task_like_count": 0,
            "wrapper_like_count": 0,
            "labels": [],
            "top_candidates": [],
        }
    support_count = int(row["support_count"])
    return {
        "source_kind": row["source_kind"],
        "present": True,
        "support_count": support_count,
        "evidence_fact_count": int(row["evidence_fact_count"]),
        "task_like_count": int(row["task_like_count"]),
        "wrapper_like_count": int(row["wrapper_like_count"]),
        "task_like_ratio": round(int(row["task_like_count"]) / support_count, 4) if support_count else 0.0,
        "labels": sorted(row["labels"]),
        "top_candidates": row["top_candidates"],
    }


def build_report(baseline: dict[str, Any], hybrid: dict[str, Any], baseline_path: str, hybrid_path: str) -> dict[str, Any]:
    baseline_source = str(baseline.get("source_kind") or "baseline")
    hybrid_source = str(hybrid.get("source_kind") or "hybrid")
    baseline_actions = action_rows(baseline, baseline_path)
    hybrid_actions = action_rows(hybrid, hybrid_path)
    action_keys = sorted(set(baseline_actions) | set(hybrid_actions))
    actions = []
    for action in action_keys:
        baseline_row = serialize_source_action(baseline_actions.get(action), baseline_source)
        hybrid_row = serialize_source_action(hybrid_actions.get(action), hybrid_source)
        total_support = int(baseline_row["support_count"]) + int(hybrid_row["support_count"])
        total_evidence = int(baseline_row["evidence_fact_count"]) + int(hybrid_row["evidence_fact_count"])
        actions.append({
            "action": action,
            "present_in_sources": [
                source["source_kind"]
                for source in [baseline_row, hybrid_row]
                if source["present"]
            ],
            "total_support_count": total_support,
            "total_evidence_fact_count": total_evidence,
            "total_task_like_count": int(baseline_row["task_like_count"]) + int(hybrid_row["task_like_count"]),
            "sources": [baseline_row, hybrid_row],
        })
    actions.sort(key=lambda row: (-int(row["total_evidence_fact_count"]), str(row["action"])))
    failures = []
    if baseline.get("decision") != "workflow_candidates_ranked":
        failures.append("baseline workflow report is not ranked")
    if hybrid.get("decision") != "workflow_candidates_ranked":
        failures.append("hybrid workflow report is not ranked")
    if len(actions) < 3:
        failures.append("combined report has fewer than 3 graph actions")
    shared_actions = [row["action"] for row in actions if len(row["present_in_sources"]) > 1]
    if len(shared_actions) < 2:
        failures.append("fewer than 2 graph actions are shared across sources")
    return {
        "schema": "ax.workflow_candidate_combined_report.v1",
        "sources": [
            source_summary(baseline, baseline_path),
            source_summary(hybrid, hybrid_path),
        ],
        "actions": actions,
        "summary": {
            "action_count": len(actions),
            "shared_action_count": len(shared_actions),
            "shared_actions": shared_actions,
            "total_evidence_fact_count": sum(int(row["total_evidence_fact_count"]) for row in actions),
            "total_task_like_count": sum(int(row["total_task_like_count"]) for row in actions),
        },
        "failures": failures,
        "decision": "workflow_candidate_sources_combined" if not failures else "needs_workflow_candidate_combination_review",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.baseline), load_json(args.hybrid), args.baseline, args.hybrid)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("workflow candidate combined report")
        print(f"decision: {report['decision']}")
        print(f"actions: {report['summary']['action_count']}")
        print(f"shared actions: {report['summary']['shared_action_count']}")
        print(f"evidence facts: {report['summary']['total_evidence_fact_count']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "workflow_candidate_sources_combined" else 1


if __name__ == "__main__":
    raise SystemExit(main())
