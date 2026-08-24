#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from statistics import mean
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rank transcript-backed classifier workflow candidates with reviewable evidence.")
    parser.add_argument("--source-kind", default="transcript_classifier_projection")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--examples", type=int, default=5)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8521")
    parser.add_argument("--user", default="root")
    parser.add_argument("--pass", dest="password", default="root")
    parser.add_argument("--ns", default="ax")
    parser.add_argument("--db", default="main")
    parser.add_argument("--out", default=".ax/experiments/workflow-candidate-report-e156.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def run_surreal_query(args: argparse.Namespace) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    source_kind = args.source_kind.replace("\\", "\\\\").replace("\"", "\\\"")
    sql = f"""
SELECT graph_id, label, properties_json
FROM classifier_graph_node
WHERE source_kind = "{source_kind}" AND kind = "classifier_candidate_group";
SELECT graph_id, subject, object, properties_json
FROM classifier_graph_fact
WHERE source_kind = "{source_kind}" AND kind = "classifier_candidate_evidence";
"""
    completed = subprocess.run(
        [
            "surreal",
            "sql",
            "--hide-welcome",
            "--json",
            "--multi",
            "--endpoint",
            args.endpoint,
            "--user",
            args.user,
            "--pass",
            args.password,
            "--ns",
            args.ns,
            "--db",
            args.db,
        ],
        input=sql,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "surreal query failed")
    chunks = []
    for line in completed.stdout.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            chunks.append(json.loads(stripped))
    if len(chunks) < 2:
        raise RuntimeError(f"expected two Surreal result chunks, got {len(chunks)}")
    return list(chunks[0][0] or []), list(chunks[1][0] or [])


def parse_properties(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("properties_json")
    if not isinstance(raw, str) or not raw:
        return {}
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, dict) else {}


def compact_text(text: str, limit: int = 220) -> str:
    squashed = " ".join(text.split())
    if len(squashed) <= limit:
        return squashed
    return squashed[: limit - 1].rstrip() + "..."


def confidence_score(confidence_values: list[float]) -> float:
    if not confidence_values:
        return 0.0
    return round(mean(confidence_values), 4)


def task_like_text(text: str) -> bool:
    lowered = " ".join(text.lower().split())
    return (
        lowered.startswith("you are implementing task") or
        lowered.startswith("implement task ") or
        lowered.startswith("spec compliance review") or
        lowered.startswith("re-review task") or
        lowered.startswith("quick review of") or
        "worktree:" in lowered or
        "do not edit files. review only" in lowered
    )


def candidate_score(support_count: int, evidence_count: int, average_confidence: float, action: str, task_like_count: int = 0) -> float:
    action_weight = {
        "add_verification_gate": 1.15,
        "add_context_guardrail": 1.1,
        "record_guidance_or_environment_preference": 1.0,
        "record_approval_checkpoint": 0.65,
    }.get(action, 0.8)
    raw_score = (support_count * 1.0 + min(evidence_count, 10) * 0.25) * max(average_confidence, 0.1) * action_weight
    task_ratio = task_like_count / support_count if support_count > 0 else 0.0
    penalty = 1.0 - min(task_ratio, 0.75) * 0.6
    return round(raw_score * penalty, 4)


def build_report(
    group_rows: list[dict[str, Any]],
    evidence_rows: list[dict[str, Any]],
    source_kind: str,
    limit: int,
    examples_per_group: int,
) -> dict[str, Any]:
    evidence_by_group: dict[str, list[dict[str, Any]]] = {}
    for row in evidence_rows:
        evidence_by_group.setdefault(str(row.get("subject") or ""), []).append(row)

    candidates: list[dict[str, Any]] = []
    for group_row in group_rows:
        group_id = str(group_row.get("graph_id") or "")
        props = parse_properties(group_row)
        evidence = evidence_by_group.get(group_id, [])
        examples: list[dict[str, Any]] = []
        confidence_values: list[float] = []
        wrapper_like_count = 0
        task_like_count = 0
        turn_refs = set()
        for evidence_row in evidence:
            evidence_props = parse_properties(evidence_row)
            confidence = evidence_props.get("confidence")
            if isinstance(confidence, (int, float)):
                confidence_values.append(float(confidence))
            if evidence_props.get("wrapper_like") is True:
                wrapper_like_count += 1
            text_excerpt = str(evidence_props.get("text_excerpt") or "")
            if task_like_text(text_excerpt):
                task_like_count += 1
            turn = evidence_props.get("turn")
            if isinstance(turn, str) and turn:
                turn_refs.add(turn)
            if len(examples) < examples_per_group:
                examples.append({
                    "result_id": evidence_props.get("result_id") or evidence_props.get("window_id"),
                    "turn": evidence_props.get("turn"),
                    "confidence": evidence_props.get("confidence"),
                    "task_like": task_like_text(text_excerpt),
                    "text_excerpt": compact_text(text_excerpt),
                })
        support_count = int(props.get("support_count") or len(evidence))
        action = str(props.get("proposed_action") or "review_section_pattern")
        average_confidence = confidence_score(confidence_values)
        candidates.append({
            "group_id": group_id,
            "label": group_row.get("label"),
            "classifier_key": props.get("classifier_key"),
            "classifier_label": props.get("label"),
            "target": props.get("target"),
            "proposed_action": action,
            "support_count": support_count,
            "evidence_count": len(evidence),
            "turn_ref_count": len(turn_refs),
            "average_confidence": average_confidence,
            "wrapper_like_count": wrapper_like_count,
            "task_like_count": task_like_count,
            "task_like_ratio": round(task_like_count / support_count, 4) if support_count > 0 else 0.0,
            "score": candidate_score(support_count, len(evidence), average_confidence, action, task_like_count),
            "examples": examples,
        })
    candidates.sort(key=lambda candidate: (-float(candidate["score"]), -int(candidate["support_count"]), str(candidate["label"])))
    top_candidates = candidates[: max(1, limit)]
    failures = []
    if not candidates:
        failures.append("no transcript-backed workflow candidates")
    if any(int(candidate["wrapper_like_count"]) > 0 for candidate in candidates):
        failures.append("candidate evidence includes wrapper-like turns")
    if any(int(candidate["evidence_count"]) == 0 for candidate in candidates):
        failures.append("candidate missing evidence facts")
    return {
        "schema": "ax.workflow_candidate_report.v1",
        "source_kind": source_kind,
        "query": {
            "limit": limit,
            "examples_per_group": examples_per_group,
        },
        "candidates": top_candidates,
        "all_candidate_labels": [candidate["label"] for candidate in candidates],
        "totals": {
            "candidate_group_count": len(candidates),
            "returned_candidate_count": len(top_candidates),
            "evidence_fact_count": len(evidence_rows),
            "candidate_with_evidence_count": sum(1 for candidate in candidates if int(candidate["evidence_count"]) > 0),
            "wrapper_like_count": sum(int(candidate["wrapper_like_count"]) for candidate in candidates),
            "task_like_count": sum(int(candidate["task_like_count"]) for candidate in candidates),
        },
        "failures": failures,
        "decision": "workflow_candidates_ranked" if not failures else "needs_workflow_candidate_review",
    }


def main() -> int:
    args = parse_args()
    group_rows, evidence_rows = run_surreal_query(args)
    report = build_report(group_rows, evidence_rows, args.source_kind, args.limit, args.examples)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("workflow candidate report")
        print(f"decision: {report['decision']}")
        print(f"candidate groups: {report['totals']['candidate_group_count']}")
        print(f"evidence facts: {report['totals']['evidence_fact_count']}")
        print(f"wrapper-like evidence: {report['totals']['wrapper_like_count']}")
        for candidate in report["candidates"]:
            print(f"- {candidate['score']} {candidate['label']} -> {candidate['proposed_action']} support={candidate['support_count']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "workflow_candidates_ranked" else 1


if __name__ == "__main__":
    raise SystemExit(main())
