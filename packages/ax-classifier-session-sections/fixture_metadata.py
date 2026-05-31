#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Add experimental grouping metadata to session-section fixture JSONL.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--out", default=".ax/experiments/chunks-with-metadata.jsonl")
    return parser.parse_args()


def text_for(row: dict[str, Any]) -> str:
    return f"{row.get('name', '')}\n{row.get('target', '')}\n{row.get('text', '')}".lower()


def contains_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(needle in text for needle in needles)


def approval_boundary_group(text: str) -> str:
    if contains_any(text, ("package", "fixtures")):
        return "approval_package"
    if contains_any(text, ("what is next", "whats next", "what's next", "next?")):
        return "approval_next_step"
    if contains_any(text, ("run it", "build this", "alright go", "\ngo", "start")):
        return "approval_start_work"
    if contains_any(text, ("eval", "fixed-fold", "run", "benchmark")):
        return "approval_continue_eval"
    if contains_any(text, ("sync", "markdown", "plan")):
        return "approval_plan_doc"
    if contains_any(text, ("hybrid", "review", "gate")):
        return "approval_architecture"
    if contains_any(text, ("continue", "keep going", "keep moving")):
        return "approval_resume_work"
    if contains_any(text, ("awesome", "looks good")):
        return "approval_positive_ack"
    return "approval_general"


def none_boundary_group(text: str) -> str:
    if contains_any(text, ("goal", "benchmark", "ten iterations")):
        return "none_goal_planning"
    if contains_any(text, ("results", "summary", "summarize", "tell me the result")):
        return "none_results_summary"
    if contains_any(text, ("eval mechanism", "test mechanism", "evals question")):
        return "none_eval_mechanism_question"
    if contains_any(text, ("setfit", "embedding", "model")):
        return "none_model_question"
    if contains_any(text, ("architecture", "graph", "service", "open source", "surrealml", "maintain")):
        return "none_architecture_question"
    if contains_any(text, ("dirty", "commit", "task", "status")):
        return "none_workflow_status"
    if contains_any(text, ("html", "open", "output", "review")):
        return "none_artifact_inspection"
    if contains_any(text, ("next", "continue", "go", "build")):
        return "none_continuation_question"
    return "none_general_question"


def boundary_group_for(row: dict[str, Any]) -> str:
    label = str(row.get("label") or "")
    text = text_for(row)
    if label == "approval":
        return approval_boundary_group(text)
    if label == "none":
        return none_boundary_group(text)
    return str(row.get("target") or label)


def source_group_for(row: dict[str, Any]) -> str:
    explicit = str(row.get("source_group") or "")
    if explicit:
        return explicit
    row_id = str(row.get("id") or "")
    if "/" in row_id:
        return row_id.rsplit("/", 1)[0]
    return str(row.get("suite") or "unknown")


PAIR_GROUP_BY_NAME = {
    "verification-evals-question": "eval_mechanism_boundary",
    "verification-regression": "eval_mechanism_boundary",
    "verification-show-regression-delta": "eval_mechanism_boundary",
    "none-architecture-question": "graph_architecture_boundary",
    "verification-prove-graph-evidence": "graph_architecture_boundary",
    "approval-continue": "continue_state_boundary",
    "approval-continue-evals": "continue_state_boundary",
    "none-continue": "continue_state_boundary",
    "none-whats-next-after-complete": "continue_state_boundary",
}


def pair_group_for(row: dict[str, Any]) -> str:
    name = str(row.get("name") or "")
    if name in PAIR_GROUP_BY_NAME:
        return PAIR_GROUP_BY_NAME[name]
    return f"{boundary_group_for(row)}::{row.get('label')}"


def enrich_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched = []
    for row in rows:
        enriched.append({
            **row,
            "source_group": source_group_for(row),
            "boundary_group": boundary_group_for(row),
            "pair_group": pair_group_for(row),
        })
    return enriched


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n")


def main() -> int:
    args = parse_args()
    rows = enrich_rows(load_jsonl(args.fixtures))
    write_jsonl(args.out, rows)
    print(f"enriched rows: {len(rows)}")
    print(f"out: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
