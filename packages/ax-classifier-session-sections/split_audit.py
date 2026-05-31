#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import apply_label_mode, grouped_stratified_split, load_rows  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit grouped train/test splits for session-section fixtures.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--group-field", default="target")
    parser.add_argument("--pair-field", default=None)
    parser.add_argument("--seeds", default="7,13,42")
    parser.add_argument("--label-mode", choices=["fine", "coarse"], default="coarse")
    parser.add_argument("--out", default=".ax/experiments/session-section-split-audit.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def parse_seeds(value: str) -> list[int]:
    seeds = [int(part.strip()) for part in value.split(",") if part.strip()]
    if not seeds:
        raise ValueError("--seeds must include at least one integer")
    return seeds


def labels(rows: list[dict[str, Any]]) -> dict[str, int]:
    return dict(sorted(Counter(str(row["label"]) for row in rows).items()))


def groups(rows: list[dict[str, Any]], group_field: str) -> set[str]:
    return {str(row[group_field]) for row in rows}


def optional_groups(rows: list[dict[str, Any]], group_field: str | None) -> set[str]:
    if group_field is None:
        return set()
    return groups(rows, group_field)


def label_group_summary(rows: list[dict[str, Any]], group_field: str) -> dict[str, dict[str, Any]]:
    by_label_group: dict[str, Counter[str]] = {}
    for row in rows:
        label = str(row["label"])
        by_label_group.setdefault(label, Counter())
        by_label_group[label][str(row[group_field])] += 1
    summary: dict[str, dict[str, Any]] = {}
    for label, group_counts in sorted(by_label_group.items()):
        largest_group, largest_count = group_counts.most_common(1)[0]
        summary[label] = {
            "group_count": len(group_counts),
            "largest_group": largest_group,
            "largest_group_rows": largest_count,
            "monolithic": len(group_counts) == 1,
        }
    return summary


def audit_split(
    train: list[dict[str, Any]],
    test: list[dict[str, Any]],
    group_field: str,
    pair_field: str | None = None,
) -> dict[str, Any]:
    train_groups = groups(train, group_field)
    test_groups = groups(test, group_field)
    train_pair_groups = optional_groups(train, pair_field)
    test_pair_groups = optional_groups(test, pair_field)
    return {
        "train_rows": len(train),
        "test_rows": len(test),
        "train_labels": labels(train),
        "test_labels": labels(test),
        "train_group_count": len(train_groups),
        "test_group_count": len(test_groups),
        "overlap_groups": sorted(train_groups & test_groups),
        "train_pair_group_count": len(train_pair_groups),
        "test_pair_group_count": len(test_pair_groups),
        "overlap_pair_groups": sorted(train_pair_groups & test_pair_groups),
    }


def audit_seeds(
    rows: list[dict[str, Any]],
    seeds: list[int],
    group_field: str,
    pair_field: str | None = None,
) -> dict[str, Any]:
    runs = []
    for seed in seeds:
        try:
            train, test = grouped_stratified_split(rows, seed, group_field)
            split = audit_split(train, test, group_field, pair_field)
            has_overlap = bool(split["overlap_groups"] or split["overlap_pair_groups"])
            runs.append({
                "seed": seed,
                "decision": "leaky_split" if has_overlap else "viable_split",
                **split,
            })
        except ValueError as error:
            runs.append({
                "seed": seed,
                "decision": "unviable_split",
                "error": str(error),
            })
    return {
        "schema": "ax.session_section_split_audit.v1",
        "fixtures": len(rows),
        "group_field": group_field,
        "pair_field": pair_field,
        "labels": labels(rows),
        "group_count": len(groups(rows, group_field)),
        "pair_group_count": len(optional_groups(rows, pair_field)),
        "label_group_summary": label_group_summary(rows, group_field),
        "seeds": seeds,
        "runs": runs,
    }


def main() -> int:
    args = parse_args()
    rows = apply_label_mode(load_rows(args.fixtures), args.label_mode)
    report = audit_seeds(rows, parse_seeds(args.seeds), args.group_field, args.pair_field)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        viable = sum(1 for run in report["runs"] if run["decision"] == "viable_split")
        print("session-section split audit")
        print(f"fixtures: {report['fixtures']}")
        print(f"group field: {report['group_field']}")
        if report["pair_field"] is not None:
            print(f"pair field: {report['pair_field']}")
        print(f"groups: {report['group_count']}")
        if report["pair_field"] is not None:
            print(f"pair groups: {report['pair_group_count']}")
        print(f"viable splits: {viable}/{len(report['runs'])}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
