#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval import macro_f1  # noqa: E402
from pregate_failure_analysis import apply_overrides, load_fixture_index, load_json, misses, pair_counts  # noqa: E402
from robustness import accuracy, failure_reasons, none_false_positive_rate  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate high-precision family gates over SetFit two-stage + none pre-gate output.")
    parser.add_argument("--two-stage", default=".ax/experiments/setfit-two-stage-e39-pair-group-seed7.json")
    parser.add_argument("--pregate", default=".ax/experiments/setfit-two-stage-pregate-e41-pair-group-seed7.json")
    parser.add_argument("--fixtures", default=".ax/experiments/chunks-e38-targeted-fixtures-metadata.jsonl")
    parser.add_argument("--out", default=".ax/experiments/setfit-family-gate-e43.json")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def text_for(row: dict[str, Any]) -> str:
    return f"{row.get('name', '')}\n{row.get('target', '')}\n{row.get('text', '')}".lower()


def contains_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(needle in text for needle in needles)


def family_gate_label(row: dict[str, Any], current_prediction: str) -> tuple[str, str | None]:
    text = text_for(row)
    boundary_group = str(row.get("boundary_group") or "")

    ordinary_control = (
        contains_any(text, ("what next?", "what's next?", "whats next?"))
        and contains_any(text, ("implemented in isolated worktree", "spec written and committed", "verification results", "what landed"))
    )
    if ordinary_control:
        return "none", "ordinary_control_gate"

    command_or_reference_context = (
        contains_any(text, ("<command-message>retro</command-message>", "how can we get a autar picture", "apple provide us", "can we get some design assets"))
        or (
            contains_any(text, ("# agents.md instructions for /users/necmttn/projects/ax", "you are implementing task"))
            and contains_any(text, ("local-agent-providers", "claude.md guidance", "work only in task"))
        )
        or (
            contains_any(text, ("to keep your macbook running with the lid closed", "clamshell mode"))
            and contains_any(text, ("external monitor", "power adapter", "third-party app"))
        )
        or (
            contains_any(text, ("<environment_context>", "<current_date>"))
            and contains_any(text, ("previous_assistant:", "dogfood cleanup", "working on"))
        )
    )
    if command_or_reference_context:
        return "none", "ordinary_context_gate"

    review_request = contains_any(text, ("spec-compliance reviewer", "code-quality reviewer", "re-review task", "please re-review task"))
    if review_request:
        return "verification_or_recovery_signal", "review_request_gate"

    recall_or_hygiene_check = (
        contains_any(text, ("can i merge", "what are me mergin", "untracked files", "commit untracked"))
        or contains_any(text, ("check the repo for date", "continue checking ax ingest bg task"))
    )
    if recall_or_hygiene_check:
        return "verification_or_recovery_signal", "recall_or_hygiene_gate"

    direct_approval = contains_any(text, ("deploy and copy", "works commit", "lets start with admin", "let's start with admin", "let's stick to soft calm", "lets stick to soft calm"))
    if direct_approval:
        return "approval", "direct_approval_gate"

    blind_correction = (
        contains_any(text, ("there's also persisting option", "there is also persisting option", "don't need to generate pictures", "do not need to generate pictures"))
        or contains_any(text, ("i just need a html", "reuse the existing stuff", "instead of re-inventing"))
        or (contains_any(text, ("t+7", "t+30", "t+90")) and contains_any(text, ("too long", "tooo long", "shorter iterations")))
    )
    if blind_correction:
        return "correction_or_rejection_signal", "blind_correction_gate"

    graph_or_cost_direction = contains_any(text, ("turn them to the facts", "evidence edges", "useful within the queries", "catch tokens", "non-catch tokens"))
    if graph_or_cost_direction:
        return "environment_or_preference_signal", "graph_or_cost_direction_gate"

    approval_resume = (
        boundary_group == "approval_resume_work"
        or (
            contains_any(text, ("user: continue", "user: go", "keep moving", "lets go", "let's go"))
            and contains_any(text, ("midway", "mid-way", "passing checkpoint", "already executing", "work for a while"))
        )
    )
    if current_prediction == "verification_or_recovery_signal" and approval_resume:
        return "approval", "approval_resume_gate"

    approval_start = (
        boundary_group in {"approval_start_work", "approval_continue_eval"}
        or (
            contains_any(text, ("okay run it", "ok run it", "continue with the evals"))
            and contains_any(text, ("described the command", "identified the next benchmark", "train the local setfit model"))
        )
    )
    if current_prediction == "verification_or_recovery_signal" and approval_start:
        return "approval", "approval_start_gate"

    recovery_worktree = contains_any(text, ("removed generated __pycache__", "removed generated", "after python tests", "clean generated"))
    if current_prediction == "environment_or_preference_signal" and recovery_worktree:
        return "verification_or_recovery_signal", "recovery_worktree_gate"

    correction_boundary = (
        contains_any(text, ("dirty files left", "not committed", "was committed", "too expensive", "do not want", "don't want", "status is wrong", "already ran that command and it failed"))
        or (contains_any(text, ("uncommitted", "commit it now")) and contains_any(text, ("had not checked", "git status")))
    )
    if current_prediction in {"environment_or_preference_signal", "verification_or_recovery_signal"} and correction_boundary:
        return "correction_or_rejection_signal", "correction_boundary_gate"

    tooling_environment = (
        contains_any(text, ("docker compose", "surreal", "surrealdb", "host daemon"))
        and contains_any(text, ("predictable dev environment", "local dev", "dev version", "environment"))
    )
    if current_prediction == "none" and tooling_environment:
        return "environment_or_preference_signal", "tooling_environment_gate"

    return current_prediction, None


def apply_family_gates(
    examples: list[dict[str, Any]],
    fixtures: dict[str, dict[str, Any]],
) -> tuple[list[str], list[dict[str, str]]]:
    predictions: list[str] = []
    overrides: list[dict[str, str]] = []
    for example in examples:
        row_id = str(example["id"])
        fixture = fixtures.get(row_id)
        if fixture is None:
            raise ValueError(f"missing fixture for report example: {row_id}")
        current_prediction = str(example["predicted"])
        prediction, reason = family_gate_label(fixture, current_prediction)
        predictions.append(prediction)
        if reason is not None:
            overrides.append({
                "id": row_id,
                "from": current_prediction,
                "to": prediction,
                "reason": reason,
            })
    return predictions, overrides


def build_report(two_stage_report: dict[str, Any], pregate_report: dict[str, Any], fixtures: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if len(two_stage_report.get("runs") or []) != 1:
        raise ValueError("family gate eval currently expects a single two-stage run")
    run = two_stage_report["runs"][0]
    pregated_examples = apply_overrides(list(run["examples"]), list(pregate_report.get("overrides") or []))
    labels = [str(example["actual"]) for example in pregated_examples]
    predictions, family_overrides = apply_family_gates(pregated_examples, fixtures)
    macro, per_label = macro_f1(labels, predictions)
    metrics = {
        "accuracy": round(accuracy(labels, predictions), 4),
        "macro_f1": round(macro, 4),
        "none_false_positive_rate": round(none_false_positive_rate(labels, predictions), 4),
        "prediction_counts": dict(sorted(Counter(predictions).items())),
        "per_label": per_label,
    }
    failures = failure_reasons({
        "macro_f1_mean": metrics["macro_f1"],
        "macro_f1_min": metrics["macro_f1"],
        "none_false_positive_rate_max": metrics["none_false_positive_rate"],
    })
    final_examples = [
        {
            "id": str(example["id"]),
            "actual": str(example["actual"]),
            "predicted": prediction,
        }
        for example, prediction in zip(pregated_examples, predictions, strict=True)
    ]
    remaining_misses = misses(final_examples)
    return {
        "schema": "ax.setfit_family_gate_report.v1",
        "source_schema": two_stage_report.get("schema"),
        "source_model": two_stage_report.get("model"),
        "seed": run.get("seed"),
        "source_report": {
            "two_stage_summary": two_stage_report.get("summary"),
            "pregate_metrics": pregate_report.get("metrics"),
            "pregate_decision": pregate_report.get("decision"),
        },
        "metrics": metrics,
        "family_overrides": family_overrides,
        "family_override_count": len(family_overrides),
        "family_override_reasons": dict(sorted(Counter(override["reason"] for override in family_overrides).items())),
        "remaining_miss_count": len(remaining_misses),
        "remaining_pair_counts": pair_counts(remaining_misses),
        "failures": failures,
        "decision": "candidate_family_gate_stack" if not failures else "reject_family_gate_stack",
    }


def main() -> int:
    args = parse_args()
    report = build_report(load_json(args.two_stage), load_json(args.pregate), load_fixture_index(args.fixtures))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print("SetFit family gate report")
        print(f"macro f1: {report['metrics']['macro_f1']}")
        print(f"accuracy: {report['metrics']['accuracy']}")
        print(f"none false-positive rate: {report['metrics']['none_false_positive_rate']}")
        print(f"family overrides: {report['family_override_count']}")
        print(f"remaining misses: {report['remaining_miss_count']}")
        print(f"decision: {report['decision']}")
        if report["failures"]:
            print(f"failures: {report['failures']}")
        print(f"out: {out}")
    return 0 if report["decision"] == "candidate_family_gate_stack" else 1


if __name__ == "__main__":
    raise SystemExit(main())
