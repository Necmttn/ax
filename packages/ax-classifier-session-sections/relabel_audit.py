#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit SetFit fixed-fold misses for label contract issues before editing fixtures.")
    parser.add_argument("--robustness", default=".ax/experiments/setfit-robustness-e20-fixed-fold-seed7.json")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/chunks.jsonl")
    parser.add_argument("--out", default=".ax/experiments/setfit-relabel-audit-e21.json")
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


def compact_text(text: str, limit: int = 260) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 3].rstrip() + "..."


def coarse_label(fine_label: str) -> str:
    if fine_label in {"direction", "tooling_or_environment_issue"}:
        return "environment_or_preference_signal"
    if fine_label in {"correction", "rejection"}:
        return "correction_or_rejection_signal"
    if fine_label in {"verification_request", "recovery_action"}:
        return "verification_or_recovery_signal"
    return fine_label


def text_contains_any(text: str, needles: set[str]) -> bool:
    lowered = text.lower()
    return any(needle in lowered for needle in needles)


def audit_item(fixture: dict[str, Any], miss: dict[str, Any]) -> dict[str, Any]:
    actual = str(miss.get("actual"))
    predicted = str(miss.get("predicted"))
    fine_label = str(fixture.get("label"))
    target = str(fixture.get("target"))
    text = str(fixture.get("text") or "")
    issue = "label_boundary"
    recommendation = "keep_label_add_contrast"
    rationale = "The fixture label matches the current contract; improve contrast examples or model behavior."

    if {actual, predicted} == {"approval", "none"}:
        issue = "approval_vs_none_boundary"
        recommendation = "needs_contract_decision"
        rationale = "Approval and ordinary continuation are not separable without a sharper contract about whether this classifier should capture short go-ahead turns."
    elif actual != "none" and predicted == "none":
        issue = "missed_signal"
        recommendation = "keep_label_add_contrast"
        rationale = "This is a labeled signal that the model abstained on; keep the label and add targeted contrast only under fixed-fold checks."
    elif actual == "none" and predicted != "none":
        issue = "none_false_positive"
        recommendation = "needs_contract_decision"
        rationale = "This negative resembles a short approval; decide the approval/none contract before relabeling or adding more examples."
    elif fine_label == "rejection" and text_contains_any(text, {"too expensive", "do not", "don't", "no,"}):
        issue = "rejection_vs_environment_boundary"
        recommendation = "keep_label_add_contrast"
        rationale = "Cost language is still a rejection of the proposed approach, not an environment/preference signal by itself."
    elif fine_label == "tooling_or_environment_issue" and text_contains_any(text, {"where does", "how big", "cache", "size"}):
        issue = "tooling_question_vs_verification_boundary"
        recommendation = "needs_contract_decision"
        rationale = "This may be a runtime-report request rather than an environment issue; confirm whether size/cache questions belong in tooling or verification."
    elif fine_label == "recovery_action" and predicted in {"approval", "none"}:
        issue = "recovery_vs_status_boundary"
        recommendation = "needs_contract_decision"
        rationale = "Recovery labels describe assistant action already taken; decide whether user follow-up turns should carry this label."

    return {
        "id": fixture.get("id") or miss.get("id"),
        "fine_label": fine_label,
        "coarse_label": coarse_label(fine_label),
        "target": target,
        "actual": actual,
        "predicted": predicted,
        "confidence": miss.get("confidence"),
        "issue": issue,
        "recommendation": recommendation,
        "rationale": rationale,
        "text_excerpt": compact_text(text),
    }


def confidence_index(run: dict[str, Any]) -> dict[str, float]:
    return {
        str(row.get("id")): float(row.get("confidence") or 0.0)
        for row in run.get("raw_predictions_with_confidence", [])
    }


def selected_run(report: dict[str, Any]) -> dict[str, Any]:
    runs = report.get("runs") or []
    if not runs:
        return {}
    return min(
        runs,
        key=lambda run: (
            float((run.get("calibrated") or run).get("macro_f1") or 0.0),
            -float((run.get("calibrated") or run).get("none_false_positive_rate") or 0.0),
        ),
    )


def calibrated_misses(run: dict[str, Any]) -> list[dict[str, Any]]:
    confidences = confidence_index(run)
    misses: list[dict[str, Any]] = []
    for example in (run.get("calibrated") or {}).get("examples") or []:
        if example.get("actual") == example.get("predicted"):
            continue
        misses.append({
            **example,
            "confidence": round(confidences.get(str(example.get("id")), 0.0), 4),
        })
    return misses


def analyze_relabel_candidates(report: dict[str, Any], fixture_index: dict[str, dict[str, Any]]) -> dict[str, Any]:
    run = selected_run(report)
    audit_items = [
        audit_item(fixture_index.get(str(miss.get("id")), {"id": miss.get("id")}), miss)
        for miss in calibrated_misses(run)
    ]
    recommendations = Counter(str(item["recommendation"]) for item in audit_items)
    issues = Counter(str(item["issue"]) for item in audit_items)
    return {
        "schema": "ax.setfit_relabel_audit.v1",
        "source_report": {
            "model": report.get("model"),
            "label_mode": report.get("label_mode"),
            "fixtures": report.get("fixtures"),
            "test_ids": report.get("test_ids"),
            "decision": report.get("decision"),
            "summary": report.get("summary"),
            "calibrated_summary": report.get("calibrated_summary"),
        },
        "selected_seed": run.get("seed"),
        "summary": {
            "items": len(audit_items),
            "recommendations": dict(sorted(recommendations.items())),
            "issues": dict(sorted(issues.items())),
        },
        "items": audit_items,
        "decision": "do_not_relabel_without_contract_changes" if recommendations.get("needs_contract_decision") else "labels_look_consistent",
        "next_actions": [
            "Do not edit canonical fixtures from model predictions alone.",
            "Resolve approval-vs-none and tooling-size-vs-verification contract ambiguity first.",
            "Only then run a fixed-fold ablation and require macro F1 > 0.6229 with none FP <= 0.1667.",
        ],
    }


def main() -> int:
    args = parse_args()
    report = analyze_relabel_candidates(load_json(args.robustness), load_fixture_index(args.fixtures))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit relabel audit")
        print(f"selected seed: {report['selected_seed']}")
        print(f"items: {report['summary']['items']}")
        print(f"recommendations: {report['summary']['recommendations']}")
        print(f"issues: {report['summary']['issues']}")
        print(f"decision: {report['decision']}")
        print(f"out: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
