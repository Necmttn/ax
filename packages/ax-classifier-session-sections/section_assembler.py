#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


LABEL_TO_SECTION = {
    "direction": "preference_discovery",
    "tooling_or_environment_issue": "preference_discovery",
    "environment_or_preference_signal": "preference_discovery",
    "correction": "correction_loop",
    "rejection": "correction_loop",
    "correction_or_rejection_signal": "correction_loop",
    "verification_request": "verification_loop",
    "recovery_action": "verification_loop",
    "verification_or_recovery_signal": "verification_loop",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate AX session-section assembly fixtures.")
    parser.add_argument("--fixtures", default="packages/ax-classifier-session-sections/eval-fixtures/sections.json")
    parser.add_argument("--out", default=".ax/experiments/session-section-assembly-e5.json")
    parser.add_argument("--max-gap", type=int, default=2)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def section_type_for_label(label: str) -> str | None:
    return LABEL_TO_SECTION.get(label)


def assemble_sections(turns: list[dict[str, Any]], max_gap: int = 2) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for turn in sorted(turns, key=lambda row: int(row["seq"])):
        seq = int(turn["seq"])
        label = str(turn.get("label") or "none")
        section_type = section_type_for_label(label)
        if not section_type:
            continue
        evidence = [str(item) for item in turn.get("evidence") or []]
        if current and current["section_type"] == section_type and seq - int(current["end_seq"]) <= max_gap:
            current["end_seq"] = seq
            current["labels"] = sorted(set(current["labels"]) | {label})
            current["evidence"] = sorted(set(current["evidence"]) | set(evidence))
            continue
        if current:
            sections.append(current)
        current = {
            "section_type": section_type,
            "start_seq": seq,
            "end_seq": seq,
            "labels": [label],
            "evidence": evidence,
        }
    if current:
        sections.append(current)
    return sections


def span_overlap(a: dict[str, Any], b: dict[str, Any]) -> float:
    a_start, a_end = int(a["start_seq"]), int(a["end_seq"])
    b_start, b_end = int(b["start_seq"]), int(b["end_seq"])
    intersection = max(0, min(a_end, b_end) - max(a_start, b_start) + 1)
    union = max(a_end, b_end) - min(a_start, b_start) + 1
    return intersection / union if union else 0.0


def match_sections(expected: list[dict[str, Any]], predicted: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unused = set(range(len(predicted)))
    matches: list[dict[str, Any]] = []
    for expected_section in expected:
        best_index = None
        best_overlap = 0.0
        for index in list(unused):
            predicted_section = predicted[index]
            if predicted_section["section_type"] != expected_section["section_type"]:
                continue
            overlap = span_overlap(expected_section, predicted_section)
            if overlap > best_overlap:
                best_index = index
                best_overlap = overlap
        if best_index is not None:
            unused.remove(best_index)
            matches.append({
                "expected": expected_section,
                "predicted": predicted[best_index],
                "overlap": round(best_overlap, 4),
            })
        else:
            matches.append({
                "expected": expected_section,
                "predicted": None,
                "overlap": 0.0,
            })
    return matches


def evaluate_fixture(data: dict[str, Any], max_gap: int) -> dict[str, Any]:
    session_reports = []
    total_expected = 0
    total_predicted = 0
    matched = 0
    overlaps: list[float] = []
    predicted_with_evidence = 0
    predicted_type_counts: Counter[str] = Counter()
    for session in data.get("sessions", []):
        predicted = assemble_sections(session.get("turns", []), max_gap=max_gap)
        expected = session.get("expected", [])
        matches = match_sections(expected, predicted)
        total_expected += len(expected)
        total_predicted += len(predicted)
        matched += sum(1 for match in matches if match["predicted"] is not None)
        overlaps.extend(float(match["overlap"]) for match in matches)
        predicted_with_evidence += sum(1 for section in predicted if section.get("evidence"))
        predicted_type_counts.update(section["section_type"] for section in predicted)
        session_reports.append({
            "session": session.get("id"),
            "expected": expected,
            "predicted": predicted,
            "matches": matches,
        })
    evidence_coverage = predicted_with_evidence / total_predicted if total_predicted else 0.0
    boundary_overlap = sum(overlaps) / len(overlaps) if overlaps else 0.0
    label_accuracy = matched / total_expected if total_expected else 0.0
    duplicate_rate = max(0, total_predicted - total_expected) / total_predicted if total_predicted else 0.0
    report = {
        "fixture": data.get("name"),
        "sessions": len(data.get("sessions", [])),
        "expected_sections": total_expected,
        "predicted_sections": total_predicted,
        "matched_sections": matched,
        "section_label_accuracy": round(label_accuracy, 4),
        "boundary_overlap": round(boundary_overlap, 4),
        "evidence_coverage": round(evidence_coverage, 4),
        "duplicate_section_rate": round(duplicate_rate, 4),
        "predicted_type_counts": dict(sorted(predicted_type_counts.items())),
        "session_reports": session_reports,
    }
    failures = []
    if report["sessions"] < 10:
        failures.append("less than 10 labeled session fixtures")
    if report["expected_sections"] < 15:
        failures.append("less than 15 labeled sections")
    if report["boundary_overlap"] < 0.65:
        failures.append("boundary overlap below 0.65")
    if report["evidence_coverage"] < 0.90:
        failures.append("evidence coverage below 90%")
    report["failures"] = failures
    return report


def main() -> int:
    args = parse_args()
    data = json.loads(Path(args.fixtures).read_text())
    report = evaluate_fixture(data, max_gap=args.max_gap)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("session section assembly report")
        print(f"sessions: {report['sessions']}")
        print(f"expected sections: {report['expected_sections']}")
        print(f"predicted sections: {report['predicted_sections']}")
        print(f"label accuracy: {report['section_label_accuracy']}")
        print(f"boundary overlap: {report['boundary_overlap']}")
        print(f"evidence coverage: {report['evidence_coverage']}")
        print(f"duplicate section rate: {report['duplicate_section_rate']}")
        print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
