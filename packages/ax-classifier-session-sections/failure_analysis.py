#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


TARGET_EXAMPLES_PER_LABEL = 12
WEAK_F1_THRESHOLD = 0.50


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze SetFit eval failures and propose next labeling actions.")
    parser.add_argument("--fine", default=".ax/experiments/setfit-session-sections-e3.json")
    parser.add_argument("--coarse", default=".ax/experiments/setfit-session-sections-e3-coarse.json")
    parser.add_argument("--robustness", default=None, help="Optional robustness report to analyze instead of fine/coarse eval reports.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--out", default=".ax/experiments/setfit-failure-analysis.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def load_fixture_index(path: str) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for line in Path(path).read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        rows[str(row["id"])] = row
    return rows


def misclassified_examples(report: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        example
        for example in report.get("examples", [])
        if example.get("actual") != example.get("predicted")
    ]


def weak_labels(report: dict[str, Any], threshold: float = WEAK_F1_THRESHOLD) -> list[dict[str, Any]]:
    labels = report.get("labels") or {}
    weak: list[dict[str, Any]] = []
    for label, metrics in sorted((report.get("per_label") or {}).items()):
        f1 = float(metrics.get("f1") or 0.0)
        support = int(metrics.get("support") or 0)
        fixture_count = int(labels.get(label) or 0)
        if f1 < threshold:
            weak.append({
                "label": label,
                "f1": f1,
                "support": support,
                "fixture_count": fixture_count,
                "additional_examples_target": max(0, TARGET_EXAMPLES_PER_LABEL - fixture_count),
            })
    return sorted(weak, key=lambda item: (item["f1"], item["fixture_count"], item["label"]))


def confusion_pairs(report: dict[str, Any]) -> list[dict[str, Any]]:
    pairs: list[dict[str, Any]] = []
    for actual, predicted_counts in (report.get("confusion") or {}).items():
        for predicted, count in predicted_counts.items():
            if actual == predicted:
                continue
            pairs.append({
                "actual": actual,
                "predicted": predicted,
                "count": int(count),
            })
    return sorted(pairs, key=lambda item: (-item["count"], item["actual"], item["predicted"]))


def labeling_tasks(report_name: str, report: dict[str, Any]) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    by_actual: dict[str, list[dict[str, Any]]] = {}
    for example in misclassified_examples(report):
        by_actual.setdefault(str(example.get("actual")), []).append(example)

    for weak in weak_labels(report):
        examples = by_actual.get(weak["label"], [])
        task_type = "add_boundary_examples" if examples else "add_support_examples"
        tasks.append({
            "report": report_name,
            "label": weak["label"],
            "task_type": task_type,
            "current_f1": weak["f1"],
            "fixture_count": weak["fixture_count"],
            "additional_examples_target": weak["additional_examples_target"],
            "example_ids": [example.get("id") for example in examples],
            "confused_with": sorted({example.get("predicted") for example in examples if example.get("predicted")}),
        })
    return tasks


def confusion_family(actual: str, predicted: str) -> str:
    if actual == "none" and predicted != "none":
        return "none_false_positive"
    if actual != "none" and predicted == "none":
        return "missed_signal"
    if actual == "approval" or predicted == "approval":
        return "approval_boundary"
    return "label_boundary"


def compact_text(text: str, limit: int = 220) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3].rstrip() + "..."


def indexed_confidences(run: dict[str, Any]) -> dict[str, float]:
    return {
        str(example.get("id")): float(example.get("confidence") or 0.0)
        for example in run.get("raw_predictions_with_confidence", [])
    }


def enrich_misses(
    examples: list[dict[str, Any]],
    fixture_index: dict[str, dict[str, Any]],
    confidences: dict[str, float],
) -> list[dict[str, Any]]:
    misses: list[dict[str, Any]] = []
    for example in examples:
        if example.get("actual") == example.get("predicted"):
            continue
        example_id = str(example.get("id"))
        fixture = fixture_index.get(example_id, {})
        actual = str(example.get("actual"))
        predicted = str(example.get("predicted"))
        miss = {
            "id": example_id,
            "actual": actual,
            "predicted": predicted,
            "family": confusion_family(actual, predicted),
            "confidence": round(confidences.get(example_id, 0.0), 4),
            "fine_label": fixture.get("label"),
            "target": fixture.get("target"),
            "source_group": fixture.get("source_group"),
            "boundary_group": fixture.get("boundary_group"),
            "pair_group": fixture.get("pair_group"),
            "text_excerpt": compact_text(str(fixture.get("text") or "")),
        }
        misses.append(miss)
    return misses


def pair_counts(misses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[tuple[str, str], int] = {}
    for miss in misses:
        key = (str(miss["actual"]), str(miss["predicted"]))
        counts[key] = counts.get(key, 0) + 1
    return [
        {"actual": actual, "predicted": predicted, "count": count}
        for (actual, predicted), count in sorted(counts.items(), key=lambda item: (-item[1], item[0][0], item[0][1]))
    ]


def family_counts(misses: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for miss in misses:
        family = str(miss["family"])
        counts[family] = counts.get(family, 0) + 1
    return dict(sorted(counts.items()))


def all_seed_calibrated_misses(
    runs: list[dict[str, Any]],
    fixture_index: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    misses: list[dict[str, Any]] = []
    for run in runs:
        confidences = indexed_confidences(run)
        examples = (run.get("calibrated") or {}).get("examples") or run.get("examples") or []
        for miss in enrich_misses(examples, fixture_index, confidences):
            misses.append({
                **miss,
                "seed": run.get("seed"),
            })
    return misses


def aggregate_none_false_positives(misses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for miss in misses:
        if miss.get("family") != "none_false_positive":
            continue
        row_id = str(miss["id"])
        entry = by_id.setdefault(row_id, {
            "id": row_id,
            "actual": miss.get("actual"),
            "predicted_labels": [],
            "seeds": [],
            "hit_count": 0,
            "max_confidence": 0.0,
            "fine_label": miss.get("fine_label"),
            "target": miss.get("target"),
            "source_group": miss.get("source_group"),
            "boundary_group": miss.get("boundary_group"),
            "pair_group": miss.get("pair_group"),
            "text_excerpt": miss.get("text_excerpt"),
        })
        entry["hit_count"] += 1
        if miss.get("seed") not in entry["seeds"]:
            entry["seeds"].append(miss.get("seed"))
        if miss.get("predicted") not in entry["predicted_labels"]:
            entry["predicted_labels"].append(miss.get("predicted"))
        entry["max_confidence"] = max(float(entry["max_confidence"]), float(miss.get("confidence") or 0.0))

    rows = []
    for entry in by_id.values():
        rows.append({
            **entry,
            "seeds": sorted(entry["seeds"]),
            "predicted_labels": sorted(entry["predicted_labels"]),
            "max_confidence": round(float(entry["max_confidence"]), 4),
        })
    return sorted(rows, key=lambda item: (-int(item["hit_count"]), -float(item["max_confidence"]), item["id"]))


def run_summary(run: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "seed": run.get("seed"),
        "accuracy": run.get("accuracy"),
        "macro_f1": run.get("macro_f1"),
        "none_false_positive_rate": run.get("none_false_positive_rate"),
    }
    if "calibrated" in run:
        calibrated = run["calibrated"]
        summary["calibrated"] = {
            "accuracy": calibrated.get("accuracy"),
            "macro_f1": calibrated.get("macro_f1"),
            "none_false_positive_rate": calibrated.get("none_false_positive_rate"),
        }
    return summary


def worst_run(runs: list[dict[str, Any]]) -> dict[str, Any]:
    return min(
        runs,
        key=lambda run: (
            float((run.get("calibrated") or run).get("macro_f1") or 0.0),
            -float((run.get("calibrated") or run).get("none_false_positive_rate") or 0.0),
        ),
    )


def robustness_recommendations(report: dict[str, Any], calibrated_misses: list[dict[str, Any]]) -> list[str]:
    recommendations = []
    calibrated_summary = report.get("calibrated_summary") or report.get("summary") or {}
    if float(calibrated_summary.get("none_false_positive_rate_max") or 0.0) >= 0.10:
        recommendations.append("Add or relabel hard negatives around approval-to-start messages before more threshold tuning.")
    if float(calibrated_summary.get("macro_f1_min") or 0.0) < 0.70:
        recommendations.append("Treat the weakest split as a boundary-data problem; add examples for its actual/predicted confusion pairs.")
    if any(miss["family"] == "approval_boundary" for miss in calibrated_misses):
        recommendations.append("Separate lightweight approval from verification/recovery in the coarse label family or add approval contrast examples.")
    if any(miss["family"] == "missed_signal" for miss in calibrated_misses):
        recommendations.append("Add open-source/package and review-contract direction examples that should not abstain to none.")
    recommendations.append("Keep deterministic classifiers as the production default until repeated-split gates pass.")
    return recommendations


def analyze_robustness(report: dict[str, Any], fixture_index: dict[str, dict[str, Any]]) -> dict[str, Any]:
    runs = report.get("runs") or []
    selected = worst_run(runs) if runs else {}
    confidences = indexed_confidences(selected)
    raw_misses = enrich_misses(selected.get("examples") or [], fixture_index, confidences)
    calibrated_misses = enrich_misses((selected.get("calibrated") or {}).get("examples") or [], fixture_index, confidences)
    all_calibrated_misses = all_seed_calibrated_misses(runs, fixture_index)
    all_none_false_positives = aggregate_none_false_positives(all_calibrated_misses)
    high_confidence_misses = [
        miss
        for miss in calibrated_misses or raw_misses
        if float(miss.get("confidence") or 0.0) >= 0.60
    ]
    return {
        "schema": "ax.setfit_robustness_failure_analysis.v1",
        "decision": "needs_none_safety_review" if all_none_false_positives else "review_model_failures",
        "source_report": {
            "model": report.get("model"),
            "label_mode": report.get("label_mode"),
            "fixtures": report.get("fixtures"),
            "epochs": report.get("epochs"),
            "batch_size": report.get("batch_size"),
            "calibration_threshold": report.get("calibration_threshold"),
            "decision": report.get("decision"),
            "failures": report.get("failures") or [],
            "summary": report.get("summary"),
            "calibrated_summary": report.get("calibrated_summary"),
        },
        "runs": [run_summary(run) for run in runs],
        "worst_seed": selected.get("seed"),
        "worst_seed_raw_misses": raw_misses,
        "worst_seed_calibrated_misses": calibrated_misses,
        "raw_pair_counts": pair_counts(raw_misses),
        "calibrated_pair_counts": pair_counts(calibrated_misses),
        "calibrated_family_counts": family_counts(calibrated_misses),
        "all_seed_calibrated_family_counts": family_counts(all_calibrated_misses),
        "all_seed_none_false_positive_count": sum(int(item["hit_count"]) for item in all_none_false_positives),
        "all_seed_unique_none_false_positive_count": len(all_none_false_positives),
        "all_seed_none_false_positives": all_none_false_positives,
        "high_confidence_misses": high_confidence_misses,
        "recommended_next_actions": robustness_recommendations(report, calibrated_misses),
    }


def analyze_failures(fine: dict[str, Any], coarse: dict[str, Any]) -> dict[str, Any]:
    fine_tasks = labeling_tasks("fine", fine)
    coarse_tasks = labeling_tasks("coarse", coarse)
    return {
        "schema": "ax.setfit_failure_analysis.v1",
        "fine": {
            "macro_f1": fine.get("macro_f1"),
            "none_false_positive_rate": fine.get("none_false_positive_rate"),
            "weak_labels": weak_labels(fine),
            "confusion_pairs": confusion_pairs(fine),
            "misclassified_examples": misclassified_examples(fine),
        },
        "coarse": {
            "macro_f1": coarse.get("macro_f1"),
            "none_false_positive_rate": coarse.get("none_false_positive_rate"),
            "weak_labels": weak_labels(coarse),
            "confusion_pairs": confusion_pairs(coarse),
            "misclassified_examples": misclassified_examples(coarse),
        },
        "recommended_next_actions": [
            "Keep deterministic classifiers as production default.",
            "Do not expand plain embedding nearest-neighbor as a classifier.",
            "Add labeled boundary examples for weak SetFit labels before another training run.",
            "Prioritize none-vs-signal hard negatives for coarse mode because coarse SetFit raised none false positives.",
        ],
        "labeling_tasks": fine_tasks + coarse_tasks,
    }


def main() -> int:
    args = parse_args()
    if args.robustness:
        report = analyze_robustness(load_json(args.robustness), load_fixture_index(args.fixtures))
    else:
        report = analyze_failures(load_json(args.fine), load_json(args.coarse))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    elif args.robustness:
        print("SetFit robustness failure analysis")
        print(f"decision: {report['source_report']['decision']}")
        print(f"worst seed: {report['worst_seed']}")
        print(f"raw misses: {len(report['worst_seed_raw_misses'])}")
        print(f"calibrated misses: {len(report['worst_seed_calibrated_misses'])}")
        print(f"calibrated families: {report['calibrated_family_counts']}")
        print(f"all-seed none false positives: {report['all_seed_none_false_positive_count']}")
        print(f"unique none false positives: {report['all_seed_unique_none_false_positive_count']}")
        print(f"high confidence misses: {len(report['high_confidence_misses'])}")
        print(f"out: {out}")
    else:
        print("SetFit failure analysis")
        print(f"fine macro f1: {report['fine']['macro_f1']}")
        print(f"coarse macro f1: {report['coarse']['macro_f1']}")
        print(f"fine weak labels: {len(report['fine']['weak_labels'])}")
        print(f"coarse weak labels: {len(report['coarse']['weak_labels'])}")
        print(f"labeling tasks: {len(report['labeling_tasks'])}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
