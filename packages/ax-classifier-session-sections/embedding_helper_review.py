#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_label_review import load_json, write_json  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build review artifacts from frozen embedding helper reports.")
    parser.add_argument("--report", default=".ax/experiments/frozen-embedding-helper-svm-current.json")
    parser.add_argument("--out", default=".ax/experiments/embedding-helper-review-current.json")
    parser.add_argument("--brief", default=".ax/experiments/embedding-helper-review-current.md")
    parser.add_argument("--summary", default=".ax/experiments/embedding-helper-review-current-report.json")
    parser.add_argument("--min-positive-recall", type=float, default=0.9)
    parser.add_argument("--max-hard-negatives", type=int, default=20)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def threshold_key(value: Any) -> str:
    return "none" if value is None else str(value)


def average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def routing_sweep_summary(runs: list[dict[str, Any]], min_positive_recall: float) -> dict[str, Any]:
    by_threshold: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        for row in run.get("helper", {}).get("routing_sweep", []):
            by_threshold[threshold_key(row.get("threshold"))].append(row)

    thresholds = []
    for key, rows in sorted(by_threshold.items(), key=lambda item: (item[0] != "none", item[0])):
        summary = {
            "threshold": key,
            "run_count": len(rows),
            "setfit_call_reduction_rate_mean": round(average([float(row.get("setfit_call_reduction_rate") or 0.0) for row in rows]), 4),
            "positive_recall_after_routing_mean": round(average([float(row.get("positive_recall_after_routing") or 0.0) for row in rows]), 4),
            "none_rejection_precision_mean": round(average([float(row.get("none_rejection_precision") or 0.0) for row in rows]), 4),
            "none_rejection_recall_mean": round(average([float(row.get("none_rejection_recall") or 0.0) for row in rows]), 4),
            "positive_false_rejections_mean": round(average([float(row.get("positive_false_rejections") or 0.0) for row in rows]), 2),
        }
        thresholds.append(summary)

    eligible = [
        row
        for row in thresholds
        if float(row["positive_recall_after_routing_mean"]) >= min_positive_recall
    ]
    selected = max(
        eligible,
        key=lambda row: float(row["setfit_call_reduction_rate_mean"]),
        default=None,
    )
    return {
        "min_positive_recall": min_positive_recall,
        "thresholds": thresholds,
        "recommended_threshold": selected,
        "decision": "routing_candidate_ready_for_review" if selected else "needs_safer_routing_threshold",
    }


def aggregate_hard_negatives(runs: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for run in runs:
        seed = run.get("seed")
        predictions = {
            str(row.get("id")): row
            for row in run.get("raw_predictions_with_confidence", [])
        }
        for candidate in run.get("helper", {}).get("hard_negative_candidates", []):
            row_id = str(candidate.get("id"))
            item = by_id.setdefault(row_id, {
                "id": f"embedding-hard-negative/{row_id}",
                "source_fixture_id": row_id,
                "status": "pending_human_acceptance",
                "proposed_label": "none",
                "review_instruction": "Accept only if this row should stay a none hard negative despite being close to positive examples.",
                "seen_in_seeds": [],
                "predicted_labels": [],
                "max_confidence": 0.0,
                "max_margin": 0.0,
                "max_nearest_positive_similarity": 0.0,
                "nearest_neighbors": [],
            })
            item["seen_in_seeds"].append(seed)
            item["predicted_labels"].append(candidate.get("predicted"))
            item["max_confidence"] = round(max(float(item["max_confidence"]), float(candidate.get("confidence") or 0.0)), 4)
            item["max_margin"] = round(max(float(item["max_margin"]), float(candidate.get("margin") or 0.0)), 4)
            item["max_nearest_positive_similarity"] = round(max(
                float(item["max_nearest_positive_similarity"]),
                float(candidate.get("nearest_positive_similarity") or 0.0),
            ), 4)
            prediction = predictions.get(row_id)
            if prediction and not item["nearest_neighbors"]:
                item["nearest_neighbors"] = list(prediction.get("nearest_neighbors", []))

    rows = []
    for item in by_id.values():
        predicted_counts = Counter(str(label) for label in item["predicted_labels"])
        item["seed_count"] = len(item["seen_in_seeds"])
        item["seen_in_seeds"] = sorted(item["seen_in_seeds"])
        item["predicted_label_counts"] = dict(sorted(predicted_counts.items()))
        item["predicted_labels"] = sorted(predicted_counts, key=lambda label: (-predicted_counts[label], label))
        rows.append(item)

    return sorted(
        rows,
        key=lambda item: (
            int(item["seed_count"]),
            float(item["max_nearest_positive_similarity"]),
            float(item["max_confidence"]),
        ),
        reverse=True,
    )[:limit]


def dedupe_items(report: dict[str, Any]) -> list[dict[str, Any]]:
    items = []
    for index, cluster in enumerate(report.get("dedupe", {}).get("examples", []), start=1):
        ids = [str(row.get("id")) for row in cluster]
        labels = Counter(str(row.get("label")) for row in cluster)
        items.append({
            "id": f"embedding-dedupe-cluster/{index}",
            "status": "pending_review",
            "source_fixture_ids": ids,
            "labels": dict(sorted(labels.items())),
            "review_instruction": "Review whether this near-duplicate evidence cluster should be counted once in graph evidence aggregation.",
        })
    return items


def build_review(report: dict[str, Any], min_positive_recall: float, max_hard_negatives: int) -> dict[str, Any]:
    runs = list(report.get("runs", []))
    routing = routing_sweep_summary(runs, min_positive_recall)
    hard_negatives = aggregate_hard_negatives(runs, max_hard_negatives)
    dedupe = dedupe_items(report)
    failures = []
    if not runs:
        failures.append("embedding helper report has no runs")
    if not hard_negatives:
        failures.append("embedding helper report has no hard-negative candidates")
    if routing["decision"] != "routing_candidate_ready_for_review":
        failures.append("no routing threshold met the positive-recall floor")
    return {
        "schema": "ax.embedding_helper_review.v1",
        "source_report": report.get("schema"),
        "model": report.get("model"),
        "classifier": report.get("classifier"),
        "label_mode": report.get("label_mode"),
        "routing": routing,
        "hard_negative_candidates": hard_negatives,
        "dedupe_clusters": dedupe,
        "failures": failures,
        "decision": "ready_for_helper_review" if not failures else "needs_helper_review_inputs",
    }


def build_summary(review: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema": "ax.embedding_helper_review_report.v1",
        "decision": review["decision"],
        "routing_decision": review["routing"]["decision"],
        "recommended_threshold": review["routing"].get("recommended_threshold"),
        "hard_negative_candidates": len(review.get("hard_negative_candidates", [])),
        "dedupe_clusters": len(review.get("dedupe_clusters", [])),
        "failures": list(review.get("failures", [])),
    }


def excerpt(value: str, limit: int = 240) -> str:
    collapsed = re.sub(r"\s+", " ", value).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3].rstrip() + "..."


def render_markdown(review: dict[str, Any]) -> str:
    routing = review["routing"]
    selected = routing.get("recommended_threshold") or {}
    lines = [
        "# Embedding Helper Review",
        "",
        "This is an advisory review artifact. Do not promote routing, hard-negative fixtures, or dedupe behavior without human review.",
        "",
        "## Routing",
        "",
        f"- Decision: `{routing['decision']}`",
        f"- Positive recall floor: `{routing['min_positive_recall']}`",
        f"- Recommended threshold: `{selected.get('threshold', '_none_')}`",
        f"- Recommended call reduction: `{selected.get('setfit_call_reduction_rate_mean', 0.0)}`",
        f"- Recommended positive recall: `{selected.get('positive_recall_after_routing_mean', 0.0)}`",
        "",
        "| Threshold | Call reduction | Positive recall | None precision | None recall | False rejections |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in routing.get("thresholds", []):
        lines.append(
            f"| `{row['threshold']}` | `{row['setfit_call_reduction_rate_mean']}` | "
            f"`{row['positive_recall_after_routing_mean']}` | `{row['none_rejection_precision_mean']}` | "
            f"`{row['none_rejection_recall_mean']}` | `{row['positive_false_rejections_mean']}` |"
        )
    lines.extend(["", "## Hard-Negative Candidates", ""])
    for index, item in enumerate(review.get("hard_negative_candidates", []), start=1):
        neighbors = ", ".join(
            f"`{neighbor.get('id')}`/{neighbor.get('label')}@{neighbor.get('similarity')}"
            for neighbor in item.get("nearest_neighbors", [])[:5]
        ) or "_none_"
        lines.extend([
            f"### {index}. {item['source_fixture_id']}",
            "",
            f"- Candidate id: `{item['id']}`",
            f"- Status: `{item['status']}`",
            f"- Proposed label: `{item['proposed_label']}`",
            f"- Seen in seeds: `{item['seen_in_seeds']}`",
            f"- Predicted labels: `{item['predicted_label_counts']}`",
            f"- Max confidence / margin: `{item['max_confidence']}` / `{item['max_margin']}`",
            f"- Max nearest positive similarity: `{item['max_nearest_positive_similarity']}`",
            f"- Nearest neighbors: {neighbors}",
            f"- Review instruction: {item['review_instruction']}",
            "- Review notes: _pending_",
            "",
        ])
    lines.extend(["## Dedupe Clusters", ""])
    for item in review.get("dedupe_clusters", []):
        lines.extend([
            f"### {item['id']}",
            "",
            f"- Status: `{item['status']}`",
            f"- Source fixture ids: `{item['source_fixture_ids']}`",
            f"- Labels: `{item['labels']}`",
            f"- Review instruction: {excerpt(item['review_instruction'])}",
            "- Review notes: _pending_",
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    source = load_json(args.report)
    review = build_review(source, args.min_positive_recall, args.max_hard_negatives)
    write_json(args.out, review)
    brief = Path(args.brief)
    brief.parent.mkdir(parents=True, exist_ok=True)
    brief.write_text(render_markdown(review))
    summary = build_summary(review)
    write_json(args.summary, summary)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print("embedding helper review report")
        print(f"decision: {summary['decision']}")
        print(f"routing decision: {summary['routing_decision']}")
        print(f"hard-negative candidates: {summary['hard_negative_candidates']}")
        print(f"dedupe clusters: {summary['dedupe_clusters']}")
        print(f"out: {args.out}")
        print(f"brief: {args.brief}")
    return 0 if review["decision"] == "ready_for_helper_review" else 1


if __name__ == "__main__":
    raise SystemExit(main())
