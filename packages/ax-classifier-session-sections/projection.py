#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


HEADINGS = ("USER", "PREVIOUS_ASSISTANT", "RECENT_TOOL_FAILURES")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rewrite session-section fixture text with structured, non-label projection cues.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--out", default=".ax/experiments/chunks-projected.jsonl")
    parser.add_argument("--mode", choices=["cues", "raw"], default="cues")
    return parser.parse_args()


def parse_text_blocks(text: str) -> dict[str, str]:
    blocks = {heading: "" for heading in HEADINGS}
    matches = list(re.finditer(r"(?m)^(USER|PREVIOUS_ASSISTANT|RECENT_TOOL_FAILURES):\s*$", text))
    for index, match in enumerate(matches):
        heading = match.group(1)
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        blocks[heading] = text[start:end].strip()
    if not matches:
        blocks["USER"] = text.strip()
    return blocks


def contains_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(needle in text for needle in needles)


def user_intent_cues(user: str, prior: str, failures: str) -> list[str]:
    text = f"{user}\n{prior}\n{failures}".lower()
    cues: list[str] = []
    if contains_any(text, ("don't want", "dont want", "do not", "no,", "not just", "instead", "wrong", "over engineered", "too expensive")):
        cues.append("rejection_or_correction")
    if contains_any(text, ("show me", "results", "prove", "verify", "test", "eval", "benchmark", "gates", "report")):
        cues.append("verification_request")
    if contains_any(text, ("use uv", " uv", "pnpm", "nix", "docker", "surreal", "cache", "model size", "package", "fixtures", "open source", "contribute")):
        cues.append("tooling_or_environment")
    if contains_any(text, ("go ahead", "continue", "yes", "alright go", "run it", "build it", "looks good")):
        cues.append("approval_or_continue")
    if contains_any(text, ("graph", "facts", "evidence", "query", "classifier package", "previous context", "not only the user message")):
        cues.append("architecture_direction")
    return cues or ["unspecified"]


def prior_action_cues(prior: str, failures: str) -> list[str]:
    text = f"{prior}\n{failures}".lower()
    cues: list[str] = []
    if contains_any(text, ("failed", "error", "exited", "conflict", "crash")):
        cues.append("tool_failure")
    if contains_any(text, ("created", "opened", "generated", "wrote", "added")):
        cues.append("created_artifact")
    if contains_any(text, ("suggested", "proposed", "planned", "described")):
        cues.append("proposal_or_plan")
    if contains_any(text, ("stopped", "did not", "not", "without", "instead of")):
        cues.append("stopped_short")
    if contains_any(text, ("ran", "reported", "showed", "verified", "tested")):
        cues.append("reported_result")
    return cues or ["unspecified"]


def requested_next_action_cues(user: str) -> list[str]:
    text = user.lower()
    cues: list[str] = []
    if contains_any(text, ("show me", "results", "report", "which gates", "how big", "where does")):
        cues.append("show_results")
    if contains_any(text, ("use uv", "pnpm", "nix", "docker", "start surreal", "through docker compose")):
        cues.append("change_tooling")
    if contains_any(text, ("package", "fixtures", "open source", "contribute", "install", "share")):
        cues.append("change_package_shape")
    if contains_any(text, ("graph", "facts", "evidence", "query")):
        cues.append("connect_to_graph")
    if contains_any(text, ("go ahead", "continue", "run it", "build", "start")):
        cues.append("continue_work")
    return cues or ["unspecified"]


def format_cues(cues: list[str]) -> str:
    return ", ".join(dict.fromkeys(cues))


def raw_field(name: str, value: str) -> str:
    return f"FIELD {name}\n{value}\nEND_FIELD"


def project_raw_fields(blocks: dict[str, str]) -> str:
    parts = [raw_field("user_message", blocks["USER"])]
    if blocks["PREVIOUS_ASSISTANT"]:
        parts.append(raw_field("previous_agent_action", blocks["PREVIOUS_ASSISTANT"]))
    if blocks["RECENT_TOOL_FAILURES"]:
        parts.append(raw_field("recent_tool_failures", blocks["RECENT_TOOL_FAILURES"]))
    return "\n\n".join(parts)


def project_text(text: str, mode: str = "cues") -> str:
    blocks = parse_text_blocks(text)
    if mode == "raw":
        return project_raw_fields(blocks)
    if mode != "cues":
        raise ValueError(f"unknown projection mode: {mode}")
    user = blocks["USER"]
    prior = blocks["PREVIOUS_ASSISTANT"]
    failures = blocks["RECENT_TOOL_FAILURES"]
    parts = [
        f"USER_INTENT_CUES:\n{format_cues(user_intent_cues(user, prior, failures))}",
        f"PRIOR_ACTION_CUES:\n{format_cues(prior_action_cues(prior, failures))}",
        f"REQUESTED_NEXT_ACTION_CUES:\n{format_cues(requested_next_action_cues(user))}",
        f"USER:\n{user}",
    ]
    if prior:
        parts.append(f"PREVIOUS_ASSISTANT:\n{prior}")
    if failures:
        parts.append(f"RECENT_TOOL_FAILURES:\n{failures}")
    return "\n\n".join(parts)


def transform_rows(rows: list[dict[str, Any]], mode: str = "cues") -> list[dict[str, Any]]:
    return [
        {
            **row,
            "text": project_text(str(row.get("text") or ""), mode=mode),
        }
        for row in rows
    ]


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")


def main() -> int:
    args = parse_args()
    rows = transform_rows(load_jsonl(args.fixtures), mode=args.mode)
    write_jsonl(args.out, rows)
    print(f"projected rows: {len(rows)}")
    print(f"mode: {args.mode}")
    print(f"out: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
