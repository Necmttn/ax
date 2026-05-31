#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from none_safety_pregate import none_safety_reason  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay the none-safety gate over unlabeled exported model windows.")
    parser.add_argument("--windows", default=".ax/experiments/model-windows-none-safety-current.jsonl")
    parser.add_argument("--out", default=".ax/experiments/none-safety-window-replay-current.json")
    parser.add_argument("--max-examples", type=int, default=50)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_jsonl(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(Path(path).read_text().splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        if not str(row.get("id") or "").strip():
            raise ValueError(f"{path}:{line_number} missing id")
        if not str(row.get("text") or "").strip():
            raise ValueError(f"{path}:{line_number} missing text")
        rows.append(row)
    return rows


def compact_text(text: str, limit: int = 300) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3].rstrip() + "..."


def light_labels(row: dict[str, Any]) -> list[str]:
    return sorted({str(label) for label in row.get("light_labels") or [] if str(label).strip()})


def light_results(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "classifier_key": str(result.get("classifier_key") or ""),
            "label": str(result.get("label") or ""),
            "target": str(result.get("target") or ""),
            "confidence": float(result.get("confidence") or 0.0),
        }
        for result in row.get("light_results") or []
    ]


def hit_for(row: dict[str, Any]) -> dict[str, Any] | None:
    reason = none_safety_reason(row)
    if reason is None:
        return None
    labels = light_labels(row)
    results = light_results(row)
    return {
        "id": str(row["id"]),
        "turn": row.get("turn"),
        "session": row.get("session"),
        "seq": row.get("seq"),
        "reason": reason,
        "light_labels": labels,
        "light_results": results,
        "potential_conflict": bool(labels or results),
        "text_excerpt": compact_text(str(row.get("text") or "")),
    }


def decision_for(window_count: int, hit_count: int, conflict_count: int) -> str:
    if window_count == 0:
        return "no_windows"
    if hit_count == 0:
        return "no_gate_hits_on_holdout"
    if conflict_count == 0:
        return "candidate_none_safety_gate_holdout"
    return "needs_conflict_review"


def build_report(rows: list[dict[str, Any]], max_examples: int = 50) -> dict[str, Any]:
    hits = [hit for row in rows if (hit := hit_for(row)) is not None]
    conflicts = [hit for hit in hits if hit["potential_conflict"]]
    reason_counts = Counter(str(hit["reason"]) for hit in hits)
    conflict_label_counts = Counter(label for hit in conflicts for label in hit["light_labels"])
    window_count = len(rows)
    hit_count = len(hits)
    conflict_count = len(conflicts)
    return {
        "schema": "ax.none_safety_window_replay.v1",
        "warning": "Unlabeled holdout replay. Deterministic light labels are weak conflict evidence, not ground truth.",
        "gate": {
            "kind": "text_projection_none_safety",
            "uses_actual_label": False,
        },
        "summary": {
            "windows": window_count,
            "gate_hits": hit_count,
            "gate_hit_rate": round(hit_count / window_count, 4) if window_count else 0.0,
            "potential_conflicts": conflict_count,
            "potential_conflict_rate": round(conflict_count / hit_count, 4) if hit_count else 0.0,
            "reason_counts": dict(sorted(reason_counts.items())),
            "conflict_label_counts": dict(sorted(conflict_label_counts.items())),
        },
        "hits": hits[:max_examples],
        "potential_conflicts": conflicts[:max_examples],
        "decision": decision_for(window_count, hit_count, conflict_count),
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_jsonl(args.windows), max_examples=args.max_examples)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        summary = report["summary"]
        print("none-safety window replay")
        print(f"windows: {summary['windows']}")
        print(f"gate hits: {summary['gate_hits']}")
        print(f"potential conflicts: {summary['potential_conflicts']}")
        print(f"decision: {report['decision']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
