#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


ALLOWED_LABELS = [
    "approval",
    "correction_or_rejection_signal",
    "environment_or_preference_signal",
    "verification_or_recovery_signal",
    "none",
]

TARGET_HINTS = [
    "continue",
    "workflow_state",
    "cost",
    "dev_environment",
    "benchmark_required",
    "regression_guard",
    "worktree_hygiene",
    "context_recall",
    "model_or_capacity_question",
    "none",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create a blind labeling pack from exported local model windows.")
    parser.add_argument("--windows", default=".ax/experiments/model-windows-e1.jsonl")
    parser.add_argument("--out", default=".ax/experiments/blind-session-section-fixtures-e46.jsonl")
    parser.add_argument("--brief", default=".ax/experiments/blind-session-section-fixtures-e46.md")
    parser.add_argument("--report", default=".ax/experiments/blind-session-section-fixtures-e46-report.json")
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--seed", type=int, default=46)
    parser.add_argument("--max-tokens", type=int, default=384)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")


def stable_key(value: str, seed: int) -> str:
    return hashlib.sha256(f"{seed}:{value}".encode("utf-8")).hexdigest()


def source_key(window_id: str) -> str:
    if ":" in window_id:
        return window_id.split(":", 1)[1]
    return window_id


def is_candidate_window(window: dict[str, Any], max_tokens: int) -> bool:
    text = str(window.get("text") or "").strip()
    if not text:
        return False
    if "<goal_context>" in text:
        return False
    if "<subagent_notification>" in text:
        return False
    if int(window.get("approx_tokens") or 0) > max_tokens:
        return False
    return True


def build_blind_rows(
    windows: list[dict[str, Any]],
    limit: int,
    seed: int,
    max_tokens: int = 384,
) -> list[dict[str, Any]]:
    candidates = [window for window in windows if is_candidate_window(window, max_tokens)]
    candidates.sort(key=lambda window: stable_key(str(window.get("id") or ""), seed))
    rows: list[dict[str, Any]] = []
    for window in candidates[:limit]:
        key = source_key(str(window.get("id") or f"row-{len(rows)}"))
        rows.append({
            "id": f"blind-session-sections/{key}",
            "source_window_id": str(window.get("id") or ""),
            "source_turn": window.get("turn"),
            "source_session": window.get("session"),
            "source_seq": window.get("seq"),
            "label": "__pending__",
            "target": "__pending__",
            "text": str(window.get("text") or ""),
            "approx_tokens": int(window.get("approx_tokens") or 0),
            "evidence": list(window.get("evidence") or []),
            "review_notes": "",
        })
    return rows


def fenced_text(value: str) -> str:
    return f"```text\n{value.rstrip()}\n```"


def render_brief(rows: list[dict[str, Any]]) -> str:
    lines = [
        "# Blind Session-Section Fixture Labeling Pack",
        "",
        "Fill `label`, `target`, and `review_notes` in the JSONL file. Do not use prior experiment predictions while labeling.",
        "",
        "Allowed labels:",
        "",
    ]
    lines.extend(f"- `{label}`" for label in ALLOWED_LABELS)
    lines.extend([
        "",
        "Suggested target vocabulary:",
        "",
    ])
    lines.extend(f"- `{target}`" for target in TARGET_HINTS)
    lines.append("")
    for index, row in enumerate(rows, start=1):
        evidence = ", ".join(str(item.get("ref") or item) for item in row.get("evidence", [])) or "_none_"
        lines.extend([
            f"## {index}. {row['id']}",
            "",
            f"- Source window: `{row['source_window_id']}`",
            f"- Source turn: `{row.get('source_turn')}`",
            f"- Source session: `{row.get('source_session')}`",
            f"- Source seq: `{row.get('source_seq')}`",
            f"- Approx tokens: `{row.get('approx_tokens')}`",
            f"- Evidence: {evidence}",
            "- Label: `__pending__`",
            "- Target: `__pending__`",
            "- Review notes:",
            "",
            fenced_text(str(row.get("text") or "")),
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def build_report(rows: list[dict[str, Any]], source_count: int, limit: int, out: str, brief: str) -> dict[str, Any]:
    failures = []
    if not rows:
        failures.append("no blind rows sampled")
    if source_count > 0 and len(rows) < min(limit, 20):
        failures.append("less than 20 blind rows sampled from available windows")
    with_previous = sum(1 for row in rows if "PREVIOUS_ASSISTANT:" in str(row.get("text") or ""))
    report = {
        "schema": "ax.blind_session_section_fixture_pack.v1",
        "source_windows": source_count,
        "sampled_rows": len(rows),
        "limit": limit,
        "out": out,
        "brief": brief,
        "pending_labels": sum(1 for row in rows if row.get("label") == "__pending__"),
        "percent_with_previous_assistant": round((with_previous / len(rows)) * 100, 1) if rows else 0.0,
        "failures": failures,
        "decision": "ready_for_manual_labeling" if not failures else "needs_source_windows",
    }
    return report


def main() -> int:
    args = parse_args()
    windows = load_jsonl(args.windows)
    rows = build_blind_rows(windows, limit=args.limit, seed=args.seed, max_tokens=args.max_tokens)
    write_jsonl(args.out, rows)
    brief_path = Path(args.brief)
    brief_path.parent.mkdir(parents=True, exist_ok=True)
    brief_path.write_text(render_brief(rows))
    report = build_report(rows, source_count=len(windows), limit=args.limit, out=args.out, brief=args.brief)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("blind fixture pack report")
        print(f"source windows: {report['source_windows']}")
        print(f"sampled rows: {report['sampled_rows']}")
        print(f"pending labels: {report['pending_labels']}")
        print(f"with previous assistant: {report['percent_with_previous_assistant']}%")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {args.out}")
        print(f"brief: {args.brief}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
