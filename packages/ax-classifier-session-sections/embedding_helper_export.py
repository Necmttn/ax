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
from embedding_helper_review_status import evaluate_review  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export accepted embedding-helper review decisions.")
    parser.add_argument("--review", default=".ax/experiments/embedding-helper-review-current.json")
    parser.add_argument("--status", default=".ax/experiments/embedding-helper-review-status-current.json")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--out", default=".ax/experiments/embedding-helper-fixture-append-current.jsonl")
    parser.add_argument("--hints", default=".ax/experiments/embedding-helper-dedupe-hints-current.json")
    parser.add_argument("--report", default=".ax/experiments/embedding-helper-export-current-report.json")
    parser.add_argument("--allow-partial-preview", action="store_true", help="Emit accepted rows for inspection even while the review gate is pending; result remains non-appendable.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()[:96] or "row"


def load_jsonl(path: str) -> list[dict[str, Any]]:
    rows = []
    for line_no, line in enumerate(Path(path).read_text().splitlines(), start=1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{line_no}: invalid JSONL row: {error}") from error
    return rows


def fixtures_by_id(path: str) -> dict[str, dict[str, Any]]:
    return {str(row.get("id")): row for row in load_jsonl(path)}


def accepted_hard_negatives(review: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in review.get("hard_negative_candidates", [])
        if str(item.get("status")) == "accepted"
    ]


def accepted_dedupe_clusters(review: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in review.get("dedupe_clusters", [])
        if str(item.get("status")) == "accepted"
    ]


def fixture_row(candidate: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    source_id = str(candidate.get("source_fixture_id"))
    name = f"embedding-helper-hard-negative-{slug(source_id)}"
    return {
        "id": f"session-section-chunks/{name}",
        "suite": "session-section-chunks",
        "name": name,
        "label": "none",
        "target": "none",
        "text": str(source.get("text") or ""),
        "source_group": "embedding-helper-hard-negative",
        "boundary_group": "none_reviewed_embedding_helper_hard_negative",
        "pair_group": "none_reviewed_embedding_helper_hard_negative::none",
        "source_fixture_id": source_id,
        "source_candidate_id": candidate.get("id"),
        "source_original_label": source.get("label"),
        "review_notes": str(candidate.get("review_notes") or ""),
        "seen_in_seeds": list(candidate.get("seen_in_seeds", [])),
        "predicted_label_counts": dict(candidate.get("predicted_label_counts", {})),
        "max_confidence": candidate.get("max_confidence"),
        "max_margin": candidate.get("max_margin"),
        "max_nearest_positive_similarity": candidate.get("max_nearest_positive_similarity"),
        "nearest_neighbors": list(candidate.get("nearest_neighbors", [])),
    }


def build_fixture_rows(review: dict[str, Any], fixture_index: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    rows = []
    missing = []
    for candidate in accepted_hard_negatives(review):
        source_id = str(candidate.get("source_fixture_id"))
        source = fixture_index.get(source_id)
        if source is None:
            missing.append(source_id)
            continue
        rows.append(fixture_row(candidate, source))
    return rows, missing


def build_dedupe_hints(review: dict[str, Any]) -> dict[str, Any]:
    clusters = []
    for cluster in accepted_dedupe_clusters(review):
        clusters.append({
            "id": cluster.get("id"),
            "source_fixture_ids": list(cluster.get("source_fixture_ids", [])),
            "labels": dict(cluster.get("labels", {})),
            "review_notes": str(cluster.get("review_notes") or ""),
            "hint": "count_as_single_evidence_cluster",
        })
    return {
        "schema": "ax.embedding_helper_dedupe_hints.v1",
        "clusters": clusters,
        "cluster_count": len(clusters),
    }


def write_jsonl(path: str, rows: list[dict[str, Any]]) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        out.write_text("")
        return
    out.write_text("\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n")


def build_report(
    review: dict[str, Any],
    status: dict[str, Any],
    rows: list[dict[str, Any]],
    hints: dict[str, Any],
    missing_fixtures: list[str],
    partial_preview: bool = False,
) -> dict[str, Any]:
    failures = []
    if status.get("decision") != "ready_for_embedding_helper_export":
        failures.append("embedding helper review is not ready for export")
    if missing_fixtures:
        failures.append("accepted embedding helper hard-negative candidates reference missing fixtures")
    decision = "ready_to_append_embedding_helper_fixtures" if not failures else "needs_embedding_helper_review"
    if partial_preview and rows and status.get("decision") != "ready_for_embedding_helper_export":
        decision = "partial_embedding_helper_export_preview"
    return {
        "schema": "ax.embedding_helper_export_report.v1",
        "review_decision": review.get("decision"),
        "status_decision": status.get("decision"),
        "partial_preview": partial_preview,
        "appendable": decision == "ready_to_append_embedding_helper_fixtures",
        "accepted_hard_negatives": len(accepted_hard_negatives(review)),
        "exported_fixture_rows": len(rows),
        "accepted_dedupe_clusters": len(accepted_dedupe_clusters(review)),
        "exported_dedupe_hints": int(hints.get("cluster_count") or 0),
        "label_counts": dict(sorted(Counter(str(row.get("label")) for row in rows).items())),
        "missing_fixtures": missing_fixtures,
        "failures": failures,
        "decision": decision,
    }


def export_review(
    review: dict[str, Any],
    status: dict[str, Any],
    fixture_index: dict[str, dict[str, Any]],
    allow_partial_preview: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    if status.get("decision") != "ready_for_embedding_helper_export":
        if allow_partial_preview:
            rows, missing = build_fixture_rows(review, fixture_index)
            hints = build_dedupe_hints(review)
            return rows, hints, build_report(review, status, rows, hints, missing, partial_preview=True)
        hints = {"schema": "ax.embedding_helper_dedupe_hints.v1", "clusters": [], "cluster_count": 0}
        report = build_report(review, status, [], hints, [])
        return [], hints, report
    rows, missing = build_fixture_rows(review, fixture_index)
    hints = build_dedupe_hints(review)
    return rows, hints, build_report(review, status, rows, hints, missing)


def main() -> int:
    args = parse_args()
    review = load_json(args.review)
    status_path = Path(args.status)
    status = load_json(args.status) if status_path.exists() else evaluate_review(review)
    fixture_index = fixtures_by_id(args.fixtures)
    rows, hints, report = export_review(review, status, fixture_index, allow_partial_preview=args.allow_partial_preview)
    write_jsonl(args.out, rows)
    write_json(args.hints, hints)
    write_json(args.report, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("embedding helper export")
        print(f"decision: {report['decision']}")
        print(f"fixture rows: {report['exported_fixture_rows']}")
        print(f"dedupe hints: {report['exported_dedupe_hints']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {args.out}")
    return 0 if report["decision"] == "ready_to_append_embedding_helper_fixtures" else 1


if __name__ == "__main__":
    raise SystemExit(main())
