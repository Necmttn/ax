#!/usr/bin/env python3
from __future__ import annotations

from typing import Any


def text_for(row: dict[str, Any]) -> str:
    return str(row.get("text") or "").lower()


def contains_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(needle in text for needle in needles)


def strict_none_reason(row: dict[str, Any]) -> str | None:
    text = text_for(row)
    if contains_any(text, ("# agents.md instructions", "<instructions>", "claude.md guidance")):
        return "context_dump_gate"
    if contains_any(text, ("you are implementing task", "files you own:", "review commit `", "do not edit files")):
        return "delegated_task_context_gate"
    if contains_any(text, ("can i merge", "is there still something missing", "commit untracked", "continue checking")):
        return "workflow_control_gate"
    if "<environment_context>" in text and contains_any(text, ("previous_assistant:", "current_date")):
        return "environment_context_wrapper_gate"
    return None


def apply_strict_none_gate(
    examples: list[dict[str, Any]],
    fixtures: dict[str, dict[str, Any]],
) -> tuple[list[str], list[dict[str, str]]]:
    predictions: list[str] = []
    overrides: list[dict[str, str]] = []
    for example in examples:
        row_id = str(example["id"])
        fixture = fixtures.get(row_id)
        if fixture is None:
            raise ValueError(f"missing fixture for report example: {row_id}")
        reason = strict_none_reason(fixture)
        if reason is not None:
            predictions.append("none")
            overrides.append({"id": row_id, "reason": reason})
        else:
            predictions.append(str(example["predicted"]))
    return predictions, overrides
