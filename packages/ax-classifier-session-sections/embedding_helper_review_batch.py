#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_label_review import load_json, write_json  # noqa: E402
from embedding_helper_review_status import evaluate_review, parse_markdown_review, sync_review_from_markdown  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate or sync focused embedding-helper review batches.")
    parser.add_argument("--mode", choices=["generate", "sync", "evaluate"], default="generate")
    parser.add_argument("--review", default=".ax/experiments/embedding-helper-review-current.json")
    parser.add_argument("--review-out", default=None, help="Optional path for the synced review JSON; useful with --dry-run.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--batch", default=".ax/experiments/embedding-helper-review-batch-current.md")
    parser.add_argument("--out", default=".ax/experiments/embedding-helper-review-batch-current-report.json")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--dry-run", action="store_true", help="Validate sync output without writing back to the review JSON.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


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


def pending_hard_negatives(review: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in review.get("hard_negative_candidates", [])
        if str(item.get("status")) == "pending_human_acceptance"
    ]


def pending_dedupe_clusters(review: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in review.get("dedupe_clusters", [])
        if str(item.get("status")) == "pending_review"
    ]


def select_batch(review: dict[str, Any], limit: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    hard = pending_hard_negatives(review)
    dedupe = pending_dedupe_clusters(review)
    selected_hard = hard[:limit]
    remaining = max(limit - len(selected_hard), 0)
    return selected_hard, dedupe[:remaining]


def fence_text(value: str) -> str:
    if "```" not in value:
        return value
    return value.replace("```", "'''")


def compact(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def render_neighbors(item: dict[str, Any]) -> str:
    rows = item.get("nearest_neighbors", [])
    if not rows:
        return "_none_"
    return ", ".join(
        f"`{row.get('id')}`/{row.get('label')}@{row.get('similarity')}"
        for row in rows
    )


def render_hard_negative(index: int, item: dict[str, Any], fixture: dict[str, Any] | None) -> list[str]:
    source_text = str((fixture or {}).get("text") or "")
    return [
        f"## {index}. Hard negative: {item.get('source_fixture_id')}",
        "",
        f"- Candidate id: `{item.get('id')}`",
        "- Item type: `hard_negative`",
        f"- Status: `{item.get('status')}`",
        "- Review notes: _pending_",
        f"- Source fixture id: `{item.get('source_fixture_id')}`",
        f"- Source fixture label/target: `{(fixture or {}).get('label', '_missing_')}` / `{(fixture or {}).get('target', '_missing_')}`",
        f"- Proposed label: `{item.get('proposed_label')}`",
        f"- Seen in seeds: `{compact(item.get('seen_in_seeds', []))}`",
        f"- Predicted labels: `{compact(item.get('predicted_label_counts', {}))}`",
        f"- Max confidence / margin: `{item.get('max_confidence')}` / `{item.get('max_margin')}`",
        f"- Max nearest positive similarity: `{item.get('max_nearest_positive_similarity')}`",
        f"- Nearest neighbors: {render_neighbors(item)}",
        f"- Review instruction: {item.get('review_instruction')}",
        "",
        "Source fixture text:",
        "",
        "```text",
        fence_text(source_text),
        "```",
        "",
    ]


def render_dedupe(index: int, item: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> list[str]:
    lines = [
        f"## {index}. Dedupe cluster: {item.get('id')}",
        "",
        f"- Cluster id: `{item.get('id')}`",
        "- Item type: `dedupe_cluster`",
        f"- Status: `{item.get('status')}`",
        "- Review notes: _pending_",
        f"- Source fixture ids: `{compact(item.get('source_fixture_ids', []))}`",
        f"- Labels: `{compact(item.get('labels', {}))}`",
        f"- Review instruction: {item.get('review_instruction')}",
        "",
    ]
    for source_id in item.get("source_fixture_ids", []):
        fixture = fixtures.get(str(source_id), {})
        lines.extend([
            f"Source fixture `{source_id}`:",
            "",
            "```text",
            fence_text(str(fixture.get("text") or "")),
            "```",
            "",
        ])
    return lines


def render_batch(review: dict[str, Any], fixtures: dict[str, dict[str, Any]], limit: int) -> tuple[str, dict[str, Any]]:
    hard, dedupe = select_batch(review, limit)
    lines = [
        "# Embedding Helper Review Batch",
        "",
        "Review only the `Status` and `Review notes` fields, then run the sync command.",
        "",
        "Status vocabulary:",
        "",
        "- Hard negatives: `accepted`, `rejected`, `pending_human_acceptance`",
        "- Dedupe clusters: `accepted`, `rejected`, `pending_review`",
        "",
        "Decision rule:",
        "",
        "- Accept a hard negative only if the source fixture should remain `none` despite being close to positive examples.",
        "- Reject a hard negative if it carries a real correction, direction, verification, approval, recovery, or environment signal.",
        "- Accept a dedupe cluster only when the fixtures should count as one evidence cluster in graph aggregation.",
        "",
    ]
    index = 1
    for item in hard:
        lines.extend(render_hard_negative(index, item, fixtures.get(str(item.get("source_fixture_id")))))
        index += 1
    for item in dedupe:
        lines.extend(render_dedupe(index, item, fixtures))
        index += 1
    report = {
        "schema": "ax.embedding_helper_review_batch_report.v1",
        "mode": "generate",
        "decision": "embedding_helper_review_batch_ready" if hard or dedupe else "no_pending_embedding_helper_review_items",
        "requested_limit": limit,
        "selected_hard_negatives": len(hard),
        "selected_dedupe_clusters": len(dedupe),
        "pending_hard_negatives": len(pending_hard_negatives(review)),
        "pending_dedupe_clusters": len(pending_dedupe_clusters(review)),
        "selected_ids": [str(item.get("id")) for item in hard] + [str(item.get("id")) for item in dedupe],
    }
    return "\n".join(lines).rstrip() + "\n", report


def sync_batch(review: dict[str, Any], batch: str, dry_run: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
    synced = sync_review_from_markdown(review, batch)
    status = evaluate_review(synced)
    report = {
        "schema": "ax.embedding_helper_review_batch_report.v1",
        "mode": "sync",
        "dry_run": dry_run,
        "would_write_review": not dry_run,
        "would_write_canonical_review": not dry_run,
        "wrote_review_out": False,
        "decision": status["decision"],
        "hard_negative_accepted": status["hard_negative_accepted"],
        "hard_negative_rejected": status["hard_negative_rejected"],
        "hard_negative_pending": status["hard_negative_pending"],
        "dedupe_accepted": status["dedupe_accepted"],
        "dedupe_rejected": status["dedupe_rejected"],
        "dedupe_pending": status["dedupe_pending"],
        "failures": list(status.get("failures", [])),
    }
    return synced, report


def selected_batch_ids(batch: str) -> list[str]:
    updates = parse_markdown_review(batch)
    return list(updates.keys())


def next_action(status: dict[str, Any]) -> str:
    if status["decision"] == "ready_for_embedding_helper_export":
        return "run embedding-helper-export"
    if status.get("hard_negative_pending"):
        return "review pending embedding-helper hard negatives"
    if status.get("dedupe_pending"):
        return "review pending embedding-helper dedupe clusters"
    return "fix embedding-helper review failures"


def evaluate_batch(review: dict[str, Any], batch: str | None = None) -> dict[str, Any]:
    status = evaluate_review(review)
    selected_ids = selected_batch_ids(batch) if batch is not None else []
    return {
        "schema": "ax.embedding_helper_review_batch_report.v1",
        "mode": "evaluate",
        "decision": status["decision"],
        "hard_negative_accepted": status["hard_negative_accepted"],
        "hard_negative_rejected": status["hard_negative_rejected"],
        "hard_negative_pending": status["hard_negative_pending"],
        "dedupe_accepted": status["dedupe_accepted"],
        "dedupe_rejected": status["dedupe_rejected"],
        "dedupe_pending": status["dedupe_pending"],
        "selected_batch_items": len(selected_ids),
        "selected_batch_ids": selected_ids,
        "next_action": next_action(status),
        "failures": list(status.get("failures", [])),
    }


def print_report(report: dict[str, Any], batch_path: str) -> None:
    print("embedding helper review batch")
    print(f"mode: {report['mode']}")
    print(f"decision: {report['decision']}")
    if report["mode"] == "generate":
        print(f"selected hard negatives: {report['selected_hard_negatives']}")
        print(f"selected dedupe clusters: {report['selected_dedupe_clusters']}")
        print(f"batch: {batch_path}")
    if report.get("failures"):
        print(f"failures: {report['failures']}")


def main() -> int:
    args = parse_args()
    review = load_json(args.review)
    if args.mode == "generate":
        markdown, report = render_batch(review, fixtures_by_id(args.fixtures), args.limit)
        batch_path = Path(args.batch)
        batch_path.parent.mkdir(parents=True, exist_ok=True)
        batch_path.write_text(markdown)
    elif args.mode == "sync":
        review, report = sync_batch(review, Path(args.batch).read_text(), dry_run=args.dry_run)
        if args.review_out:
            write_json(args.review_out, review)
            report["review_out"] = args.review_out
            report["wrote_review_out"] = True
        elif not args.dry_run:
            write_json(args.review, review)
    else:
        batch = Path(args.batch).read_text() if Path(args.batch).exists() else None
        report = evaluate_batch(review, batch)
    write_json(args.out, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report, args.batch)
    return 0 if report["decision"] in {"embedding_helper_review_batch_ready", "ready_for_embedding_helper_export"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
