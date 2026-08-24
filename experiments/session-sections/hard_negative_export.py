#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_label_review import load_json, write_json  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export accepted hard-negative candidates as append-ready fixture rows.")
    parser.add_argument("--candidates", default=".ax/experiments/blind-hard-negative-candidates-e54.json")
    parser.add_argument("--out", default=".ax/experiments/blind-hard-negative-fixture-append-e55.jsonl")
    parser.add_argument("--report", default=".ax/experiments/blind-hard-negative-fixture-append-e55-report.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def accepted_rows(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in candidates if str(row.get("status")) == "accepted"]


def slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()[:96] or "row"


def fixture_row(candidate: dict[str, Any]) -> dict[str, Any]:
    source_id = str(candidate.get("source_blind_id") or candidate.get("id"))
    name = f"blind-hard-negative-{slug(source_id)}"
    return {
        "id": f"session-section-chunks/{name}",
        "suite": "session-section-chunks",
        "name": name,
        "label": "none",
        "target": "none",
        "text": str(candidate.get("text") or ""),
        "source_group": "blind-hard-negative",
        "boundary_group": "none_reviewed_hard_negative",
        "pair_group": "none_reviewed_hard_negative::none",
        "source_blind_id": source_id,
        "source_candidate_id": candidate.get("id"),
        "review_notes": str(candidate.get("review_notes") or "accepted hard-negative candidate"),
        "risk_reasons": list(candidate.get("risk_reasons", [])),
    }


def export_rows(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [fixture_row(candidate) for candidate in accepted_rows(candidates)]


def write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        out.write_text("")
        return
    out.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")


def build_report(rows: list[dict[str, Any]], candidates: int) -> dict[str, Any]:
    failures = []
    if not rows:
        failures.append("no accepted hard-negative candidates")
    return {
        "schema": "ax.hard_negative_fixture_append_report.v1",
        "candidates": candidates,
        "accepted": len(rows),
        "label_counts": dict(sorted(Counter(str(row.get("label")) for row in rows).items())),
        "failures": failures,
        "decision": "ready_to_append_fixtures" if not failures else "needs_human_acceptance",
    }


def main() -> int:
    args = parse_args()
    candidates = list(load_json(args.candidates).get("items", []))
    rows = export_rows(candidates)
    write_jsonl(args.out, rows)
    report = build_report(rows, len(candidates))
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("hard-negative fixture append report")
        print(f"candidates: {report['candidates']}")
        print(f"accepted: {report['accepted']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_to_append_fixtures" else 1


if __name__ == "__main__":
    raise SystemExit(main())
