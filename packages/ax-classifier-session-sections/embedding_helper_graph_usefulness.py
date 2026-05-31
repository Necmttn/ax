#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "can",
    "for",
    "i",
    "is",
    "it",
    "of",
    "or",
    "the",
    "this",
    "to",
    "we",
    "what",
    "with",
    "you",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Measure workflow candidate noise against promoted embedding-helper none controls.")
    parser.add_argument("--graph-health", default=".ax/experiments/classifier-graph-health-embedding-helper-current.json")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--workflow-report", action="append", default=[])
    parser.add_argument("--out", default=".ax/experiments/embedding-helper-graph-usefulness-current.json")
    parser.add_argument("--min-token-overlap", type=float, default=0.72)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def normalized_tokens(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9][a-z0-9_-]*", text.lower())
        if token not in STOPWORDS and len(token) > 1
    }


def token_overlap(left: str, right: str) -> float:
    left_tokens = normalized_tokens(left)
    right_tokens = normalized_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens.intersection(right_tokens)) / min(len(left_tokens), len(right_tokens))


def promoted_helper_source_fixture_ids(graph_health: dict[str, Any]) -> list[str]:
    ids = []
    for fact in graph_health.get("embedding_helper_facts") or []:
        if fact.get("predicate") != "promoted_hard_negative_fixture":
            continue
        fixture_id = str(fact.get("source_fixture_id") or "")
        if fixture_id:
            ids.append(fixture_id)
    return sorted(set(ids))


def fixture_text_by_id(fixtures: list[dict[str, Any]]) -> dict[str, str]:
    return {
        str(row.get("id")): str(row.get("text") or "")
        for row in fixtures
        if str(row.get("id") or "") and str(row.get("text") or "")
    }


def helper_matches_for_example(
    example: dict[str, Any],
    promoted_fixture_ids: list[str],
    fixture_texts: dict[str, str],
    min_token_overlap: float,
) -> list[dict[str, Any]]:
    text = str(example.get("text_excerpt") or "")
    matches = []
    for fixture_id in promoted_fixture_ids:
        fixture_text = fixture_texts.get(fixture_id)
        if not fixture_text:
            continue
        score = token_overlap(text, fixture_text)
        if score >= min_token_overlap:
            matches.append({
                "source_fixture_id": fixture_id,
                "match_score": round(score, 4),
            })
    return sorted(matches, key=lambda row: (-float(row["match_score"]), str(row["source_fixture_id"])))


def annotate_workflow_report(
    report: dict[str, Any],
    path: str,
    promoted_fixture_ids: list[str],
    fixture_texts: dict[str, str],
    min_token_overlap: float,
) -> dict[str, Any]:
    candidates = []
    matched_example_count = 0
    total_support = 0
    adjusted_support = 0
    for candidate in report.get("candidates") or []:
        examples = []
        candidate_match_count = 0
        for example in candidate.get("examples") or []:
            matches = helper_matches_for_example(example, promoted_fixture_ids, fixture_texts, min_token_overlap)
            if matches:
                matched_example_count += 1
                candidate_match_count += 1
            examples.append({
                "turn": example.get("turn"),
                "result_id": example.get("result_id"),
                "text_excerpt": example.get("text_excerpt"),
                "helper_matches": matches,
            })
        support = int(candidate.get("support_count") or 0)
        total_support += support
        candidate_adjusted_support = max(0, support - candidate_match_count)
        adjusted_support += candidate_adjusted_support
        if candidate_match_count:
            candidates.append({
                "group_id": candidate.get("group_id"),
                "label": candidate.get("label"),
                "proposed_action": candidate.get("proposed_action"),
                "support_count": support,
                "matched_example_count": candidate_match_count,
                "adjusted_support_count": candidate_adjusted_support,
                "helper_matches": [
                    match
                    for example in examples
                    for match in example["helper_matches"]
                ],
                "examples": [example for example in examples if example["helper_matches"]],
            })
    return {
        "path": path,
        "source_kind": report.get("source_kind"),
        "decision": report.get("decision"),
        "candidate_group_count": len(report.get("candidates") or []),
        "candidate_group_with_matches_count": len(candidates),
        "matched_candidate_example_count": matched_example_count,
        "support_count": total_support,
        "adjusted_support_count": adjusted_support,
        "estimated_suppressed_support_count": total_support - adjusted_support,
        "candidates": sorted(candidates, key=lambda row: (-int(row["matched_example_count"]), str(row["group_id"]))),
    }


def build_report(
    graph_health: dict[str, Any],
    fixtures: list[dict[str, Any]],
    workflow_reports: list[dict[str, Any]],
    workflow_report_paths: list[str],
    min_token_overlap: float = 0.72,
) -> dict[str, Any]:
    promoted_ids = promoted_helper_source_fixture_ids(graph_health)
    fixture_texts = fixture_text_by_id(fixtures)
    workflow_summaries = [
        annotate_workflow_report(report, path, promoted_ids, fixture_texts, min_token_overlap)
        for report, path in zip(workflow_reports, workflow_report_paths)
    ]
    failures = []
    if not promoted_ids:
        failures.append("no promoted helper hard-negative facts found")
    if not workflow_reports:
        failures.append("no workflow candidate reports supplied")
    missing_text = [fixture_id for fixture_id in promoted_ids if fixture_id not in fixture_texts]
    if missing_text:
        failures.append("promoted helper fixtures missing canonical text")
    return {
        "schema": "ax.embedding_helper_graph_usefulness.v1",
        "query": {
            "min_token_overlap": min_token_overlap,
        },
        "summary": {
            "promoted_helper_fact_count": len(promoted_ids),
            "workflow_report_count": len(workflow_reports),
            "candidate_group_with_matches_count": sum(int(row["candidate_group_with_matches_count"]) for row in workflow_summaries),
            "matched_candidate_example_count": sum(int(row["matched_candidate_example_count"]) for row in workflow_summaries),
            "estimated_suppressed_support_count": sum(int(row["estimated_suppressed_support_count"]) for row in workflow_summaries),
        },
        "promoted_helper_source_fixture_ids": promoted_ids,
        "workflow_reports": workflow_summaries,
        "failures": failures,
        "decision": "embedding_helper_graph_usefulness_ready" if not failures else "needs_embedding_helper_graph_usefulness_inputs",
    }


def main() -> int:
    args = parse_args()
    workflow_paths = args.workflow_report or [
        ".ax/experiments/workflow-candidate-report-e156.json",
        ".ax/experiments/workflow-candidate-report-hybrid-window-current.json",
    ]
    report = build_report(
        graph_health=load_json(args.graph_health),
        fixtures=load_jsonl(args.fixtures),
        workflow_reports=[load_json(path) for path in workflow_paths],
        workflow_report_paths=workflow_paths,
        min_token_overlap=args.min_token_overlap,
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("embedding helper graph usefulness")
        print(f"decision: {report['decision']}")
        print(f"promoted helper facts: {report['summary']['promoted_helper_fact_count']}")
        print(f"matched candidate examples: {report['summary']['matched_candidate_example_count']}")
        print(f"candidate groups with matches: {report['summary']['candidate_group_with_matches_count']}")
        print(f"estimated suppressed support: {report['summary']['estimated_suppressed_support_count']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "embedding_helper_graph_usefulness_ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
