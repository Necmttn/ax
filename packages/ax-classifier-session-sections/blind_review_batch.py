#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from blind_review_workspace import parse_workspace  # noqa: E402
from blind_label_review import write_json  # noqa: E402
from blind_fixture_pack import ALLOWED_LABELS, TARGET_HINTS  # noqa: E402
from hard_negative_review import VALID_STATUSES  # noqa: E402
from review_note_quality import note_present, note_substantive  # noqa: E402

REVIEW_FIELD_LABELS = {
    "review_label": "Review label",
    "review_target": "Review target",
    "review_notes": "Review notes",
    "hard_negative_status": "Hard-negative status",
    "hard_negative_notes": "Hard-negative notes",
}

LABEL_GUIDANCE = {
    "approval": "User accepts or greenlights a proposed next action.",
    "correction_or_rejection_signal": "User corrects, rejects, or pushes back on behavior, evidence, scope, cost, or result.",
    "environment_or_preference_signal": "User gives durable local setup, tooling, preference, or context.",
    "verification_or_recovery_signal": "User asks to prove, test, inspect, recover, rerun, or handle failures.",
    "none": "Ordinary control/status/context that should not become a durable signal.",
}

TARGET_GUIDANCE = {
    "continue": "Approval to proceed or continue.",
    "workflow_state": "Process state, merge/readiness, task continuation, or what-next questions.",
    "cost": "Cost, expense, runtime, or avoiding brute-force concerns.",
    "dev_environment": "Tools, package manager, DB, Docker/Nix, or local setup.",
    "benchmark_required": "Asks for tests, evals, benchmarks, or proof.",
    "regression_guard": "Asks to avoid breakage or verify a trained model is still stable.",
    "worktree_hygiene": "Git, dirty files, commit state, or merge readiness.",
    "context_recall": "Asks what happened, previous task, or prior context.",
    "model_or_capacity_question": "Model choice, capacity, chunk-size, SetFit, or embedding questions.",
    "none": "No specific target.",
}

HARD_NEGATIVE_STATUS_GUIDANCE = {
    "accepted": "Row is ordinary none/control and useful as a hard-negative none boundary.",
    "rejected": "Row is a real positive signal; do not train it as none.",
    "pending_human_acceptance": "Not reviewed yet; blocks export.",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate or sync focused blind-review workspace batches.")
    parser.add_argument("--mode", choices=["generate", "sync", "evaluate", "draft-suggestions", "promote-draft"], default="generate")
    parser.add_argument("--workspace", default=".ax/experiments/blind-review-workspace-e63.md")
    parser.add_argument("--report", default=".ax/experiments/blind-review-workspace-e76-progress-refs-report.json")
    parser.add_argument("--packet", default=".ax/experiments/blind-review-packet-e61.json")
    parser.add_argument("--out", default=".ax/experiments/blind-review-batch-e77.md")
    parser.add_argument("--batch", default=None)
    parser.add_argument("--workspace-out", default=None)
    parser.add_argument("--summary", default=".ax/experiments/blind-review-batch-e77-report.json")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-incomplete", action="store_true", help="Allow mechanical sync before batch review fields are complete.")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def load_json(path: str) -> dict[str, Any]:
    return json.loads(Path(path).read_text())


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def section_blocks(markdown: str) -> dict[int, str]:
    blocks: dict[int, list[str]] = {}
    current: int | None = None
    for line in markdown.splitlines():
        heading = re.match(r"^##\s+(\d+)\.\s+(.+)$", line)
        if heading:
            current = int(heading.group(1))
            blocks[current] = [line]
            continue
        if current is not None:
            blocks[current].append(line)
    return {ordinal: "\n".join(lines).rstrip() for ordinal, lines in blocks.items()}


def split_workspace(markdown: str) -> tuple[str, list[tuple[int, str]]]:
    preamble: list[str] = []
    blocks: list[tuple[int, list[str]]] = []
    current: tuple[int, list[str]] | None = None
    for line in markdown.splitlines():
        heading = re.match(r"^##\s+(\d+)\.\s+(.+)$", line)
        if heading:
            if current is not None:
                blocks.append(current)
            current = (int(heading.group(1)), [line])
            continue
        if current is None:
            preamble.append(line)
        else:
            current[1].append(line)
    if current is not None:
        blocks.append(current)
    return "\n".join(preamble).rstrip(), [(ordinal, "\n".join(lines).rstrip()) for ordinal, lines in blocks]


def selected_ordinals(report: dict[str, Any], limit: int) -> list[int]:
    progress = report.get("progress") or {}
    refs: list[dict[str, Any]] = []
    refs.extend(progress.get("blind_label_next_pending_refs") or [])
    refs.extend(progress.get("hard_negative_next_pending_refs") or [])
    ordinals: list[int] = []
    for ref in refs:
        ordinal = int(ref.get("ordinal") or 0)
        if ordinal and ordinal not in ordinals:
            ordinals.append(ordinal)
        if len(ordinals) >= limit:
            break
    return ordinals


def selected_workspace_ordinals(report: dict[str, Any], workspace: str, limit: int) -> list[int]:
    progress = report.get("progress") or {}
    refs: list[dict[str, Any]] = []
    refs.extend(progress.get("blind_label_next_pending_refs") or [])
    refs.extend(progress.get("hard_negative_next_pending_refs") or [])
    workspace_refs = section_refs(workspace)
    ordinal_by_id = {str(ref["id"]): int(ref["ordinal"]) for ref in workspace_refs}
    workspace_ordinals = {int(ref["ordinal"]) for ref in workspace_refs}
    ordinals: list[int] = []
    for ref in refs:
        ref_id = str(ref.get("source_blind_id") or ref.get("id") or "")
        ordinal = ordinal_by_id.get(ref_id)
        if ordinal is None:
            fallback = int(ref.get("ordinal") or 0)
            ordinal = fallback if fallback in workspace_ordinals else None
        if ordinal and ordinal not in ordinals:
            ordinals.append(ordinal)
        if len(ordinals) >= limit:
            break
    return ordinals


def packet_context_by_id(packet: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item.get("id")): item for item in packet.get("items", []) if item.get("id")}


def section_id(block: str) -> str | None:
    first_line = block.splitlines()[0] if block.splitlines() else ""
    heading = re.match(r"^##\s+\d+\.\s+(.+)$", first_line)
    return heading.group(1).strip() if heading else None


def strip_inline_code(value: str) -> str:
    stripped = value.strip()
    if stripped.startswith("`") and stripped.endswith("`") and stripped.count("`") == 2:
        return stripped[1:-1].strip()
    return stripped


def block_field(block: str, field: str) -> str:
    for line in block.splitlines():
        match = re.match(rf"^- {re.escape(field)}:\s*(.*)$", line.strip())
        if match:
            return strip_inline_code(match.group(1))
    return ""


def evidence_refs_from_block(block: str) -> list[str]:
    raw = block_field(block, "Evidence")
    if raw in {"", "_none_"}:
        return []
    return re.findall(r"`([^`]+)`", raw)


def split_proposed_label_target(value: str) -> tuple[str, str]:
    parts = [strip_inline_code(part) for part in value.split("/")]
    if len(parts) != 2:
        return "", ""
    return parts[0], parts[1]


def insert_after_line(lines: list[str], prefix: str, additions: list[str]) -> list[str]:
    if not additions or any(addition in lines for addition in additions):
        return lines
    for index, line in enumerate(lines):
        if line.startswith(prefix):
            return [*lines[: index + 1], *additions, *lines[index + 1 :]]
    return [*lines, *additions]


def enrich_batch_block(block: str, context: dict[str, Any] | None) -> tuple[str, bool]:
    if not context:
        return block, False
    lines = block.splitlines()
    before = list(lines)
    hard_negative_status = context.get("hard_negative_status")
    hard_negative_proposed = (
        f"`{context.get('hard_negative_proposed_label')}` / `{context.get('hard_negative_proposed_target')}`"
        if hard_negative_status
        else "_none_"
    )
    hard_negative_instruction = str(context.get("hard_negative_review_instruction") or "").strip() or "_none_"
    evidence_refs = context.get("evidence_refs") if isinstance(context.get("evidence_refs"), list) else []
    evidence = ", ".join(f"`{ref}`" for ref in evidence_refs) or "_none_"
    lines = insert_after_line(lines, "- Hard-negative notes:", [
        f"- Hard-negative proposed label/target: {hard_negative_proposed}",
        f"- Hard-negative review instruction: {hard_negative_instruction}",
    ])
    lines = insert_after_line(lines, "- Suggested target:", [
        f"- Confidence bucket: `{context.get('confidence_bucket')}`",
        f"- Binary confidence: `{context.get('binary_confidence')}`",
        f"- Family confidence: `{context.get('family_confidence')}`",
    ])
    lines = insert_after_line(lines, "- Source window:", [
        f"- Source turn: `{context.get('source_turn')}`",
        f"- Source session: `{context.get('source_session')}`",
        f"- Source seq: `{context.get('source_seq')}`",
        f"- Approx tokens: `{context.get('approx_tokens')}`",
        f"- Evidence: {evidence}",
    ])
    return "\n".join(lines).rstrip(), lines != before


def render_batch(
    workspace: str,
    report: dict[str, Any],
    limit: int,
    context_by_id: dict[str, dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    blocks = section_blocks(workspace)
    ordinals = selected_workspace_ordinals(report, workspace, limit)
    missing = [ordinal for ordinal in ordinals if ordinal not in blocks]
    enriched_sections = 0
    lines = [
        "# Blind Review Batch",
        "",
        "Edit these sections in the main E63 workspace, then run the dry-run sync before the guarded post-review command.",
        "",
        f"- Source workspace: `.ax/experiments/blind-review-workspace-e63.md`",
        f"- Requested limit: `{limit}`",
        f"- Selected workspace sections: `{', '.join(str(ordinal) for ordinal in ordinals)}`",
        "",
        "Editable field vocabulary:",
        "",
        f"- Review labels: {', '.join(f'`{label}`' for label in ALLOWED_LABELS)}",
        f"- Review targets: {', '.join(f'`{target}`' for target in TARGET_HINTS)}",
        f"- Hard-negative statuses: {', '.join(f'`{status}`' for status in sorted(VALID_STATUSES))}",
        "- Use `_none_` only when the section has no hard-negative candidate.",
        "",
    ]
    for ordinal in ordinals:
        block = blocks.get(ordinal)
        if block:
            block_id = section_id(block)
            enriched, changed = enrich_batch_block(block, (context_by_id or {}).get(block_id or ""))
            if changed:
                enriched_sections += 1
            lines.extend([enriched, ""])
    summary = {
        "schema": "ax.blind_review_batch_report.v1",
        "workspace_sha256": sha256_text(workspace),
        "selected_ordinals": ordinals,
        "sections": len(ordinals) - len(missing),
        "context_enriched_sections": enriched_sections,
        "vocabulary_included": True,
        "allowed_label_count": len(ALLOWED_LABELS),
        "allowed_target_count": len(TARGET_HINTS),
        "allowed_hard_negative_status_count": len(VALID_STATUSES),
        "missing_ordinals": missing,
        "failures": [f"workspace section missing: {ordinal}" for ordinal in missing],
        "decision": "ready_for_batch_review" if not missing and ordinals else "needs_batch_inputs",
    }
    return "\n".join(lines).rstrip() + "\n", summary


def section_refs(markdown: str) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for ordinal, block in split_workspace(markdown)[1]:
        first_line = block.splitlines()[0] if block.splitlines() else ""
        heading = re.match(r"^##\s+\d+\.\s+(.+)$", first_line)
        if heading:
            refs.append({"ordinal": ordinal, "id": heading.group(1).strip()})
    return refs


def format_field_counts(counts: dict[str, int]) -> str:
    return ", ".join(f"{REVIEW_FIELD_LABELS.get(field, field)}: {count}" for field, count in counts.items()) or "none"


def percent(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 100.0
    return round((numerator / denominator) * 100, 1)


def review_value_done(value: str | None) -> bool:
    return bool(value and value.strip() and value.strip() not in {"__pending__", "_pending_"})


def review_note_substantive(value: str | None) -> bool:
    return note_substantive(value)


def hard_negative_done(update: dict[str, str]) -> bool:
    candidate_id = update.get("hard_negative_candidate_id")
    if not candidate_id or candidate_id == "_none_":
        return True
    return update.get("hard_negative_status") in {"accepted", "rejected"} and review_note_substantive(update.get("hard_negative_review_notes"))


def valid_review_label(value: str | None) -> bool:
    return value in set(ALLOWED_LABELS).union({"__pending__"})


def valid_review_target(value: str | None) -> bool:
    return value in set(TARGET_HINTS).union({"__pending__"})


def valid_hard_negative_status(value: str | None) -> bool:
    return value in set(VALID_STATUSES).union({"_none_", ""})


def evaluate_batch(batch: str) -> dict[str, Any]:
    refs = section_refs(batch)
    blocks = section_blocks(batch)
    updates = parse_workspace(batch)
    rows: list[dict[str, Any]] = []
    for ref in refs:
        update = updates.get(ref["id"], {})
        review_complete = (
            review_value_done(update.get("label"))
            and review_value_done(update.get("target"))
            and review_note_substantive(update.get("review_notes"))
        )
        hard_negative_required = bool(update.get("hard_negative_candidate_id") and update.get("hard_negative_candidate_id") != "_none_")
        hard_negative_complete = hard_negative_done(update)
        missing: list[str] = []
        invalid: list[str] = []
        if not review_value_done(update.get("label")):
            missing.append("review_label")
        elif not valid_review_label(update.get("label")):
            invalid.append("review_label")
        if not review_value_done(update.get("target")):
            missing.append("review_target")
        elif not valid_review_target(update.get("target")):
            invalid.append("review_target")
        if not note_present(update.get("review_notes")):
            missing.append("review_notes")
        elif not review_note_substantive(update.get("review_notes")):
            invalid.append("review_notes")
        if not valid_hard_negative_status(update.get("hard_negative_status")):
            invalid.append("hard_negative_status")
        elif hard_negative_required and update.get("hard_negative_status") not in {"accepted", "rejected"}:
            missing.append("hard_negative_status")
        if hard_negative_required:
            if not note_present(update.get("hard_negative_review_notes")):
                missing.append("hard_negative_notes")
            elif not review_note_substantive(update.get("hard_negative_review_notes")):
                invalid.append("hard_negative_notes")
        rows.append(
            {
                "ordinal": ref["ordinal"],
                "id": ref["id"],
                "review_complete": review_complete,
                "hard_negative_required": hard_negative_required,
                "hard_negative_complete": hard_negative_complete,
                "missing": missing,
                "invalid": invalid,
            }
        )
    review_complete_count = sum(1 for row in rows if row["review_complete"])
    hard_negative_required_count = sum(1 for row in rows if row["hard_negative_required"])
    hard_negative_complete_count = sum(1 for row in rows if row["hard_negative_required"] and row["hard_negative_complete"])
    invalid_rows = [row for row in rows if row["invalid"]]
    incomplete = [row for row in rows if not row["review_complete"] or not row["hard_negative_complete"] or row["invalid"]]
    missing_field_counts = Counter(field for row in incomplete for field in row["missing"])
    invalid_field_counts = Counter(field for row in incomplete for field in row["invalid"])
    missing_field_total = sum(missing_field_counts.values())
    invalid_field_total = sum(invalid_field_counts.values())
    blocking_field_total = missing_field_total + invalid_field_total
    all_fields_total = 3 * len(rows) + 2 * hard_negative_required_count
    completed_field_total = all_fields_total - blocking_field_total
    review_tasks = [review_task(row, blocks.get(int(row["ordinal"]), "")) for row in incomplete]
    return {
        "schema": "ax.blind_review_batch_eval_report.v1",
        "batch_sha256": sha256_text(batch),
        "sections": len(rows),
        "review_complete": review_complete_count,
        "review_pending": len(rows) - review_complete_count,
        "hard_negative_required": hard_negative_required_count,
        "hard_negative_complete": hard_negative_complete_count,
        "hard_negative_pending": hard_negative_required_count - hard_negative_complete_count,
        "missing_field_total": missing_field_total,
        "invalid_field_total": invalid_field_total,
        "blocking_field_total": blocking_field_total,
        "completed_field_total": completed_field_total,
        "review_field_total": all_fields_total,
        "field_completion_percent": percent(completed_field_total, all_fields_total),
        "row_completion_percent": percent(review_complete_count + hard_negative_complete_count, len(rows) + hard_negative_required_count),
        "missing_field_counts": dict(sorted(missing_field_counts.items())),
        "invalid_field_counts": dict(sorted(invalid_field_counts.items())),
        "invalid_refs": invalid_rows,
        "incomplete_refs": incomplete,
        "review_task_total": len(review_tasks),
        "review_tasks": review_tasks,
        "failures": [
            *[f"batch section incomplete: {row['ordinal']}" for row in incomplete if row["missing"]],
            *[f"batch section has invalid fields: {row['ordinal']}" for row in invalid_rows],
        ],
        "decision": "ready_for_batch_sync" if rows and not incomplete else "needs_batch_review",
    }


def review_task(row: dict[str, Any], block: str) -> dict[str, Any]:
    proposed_label, proposed_target = split_proposed_label_target(block_field(block, "Hard-negative proposed label/target"))
    return {
        "ordinal": row["ordinal"],
        "id": row["id"],
        "missing": list(row.get("missing") or []),
        "invalid": list(row.get("invalid") or []),
        "blocking_field_count": len(row.get("missing") or []) + len(row.get("invalid") or []),
        "suggested_label": block_field(block, "Suggested label"),
        "suggested_target": block_field(block, "Suggested target"),
        "confidence_bucket": block_field(block, "Confidence bucket"),
        "risk_reasons": re.findall(r"`([^`]+)`", block_field(block, "Risk reasons")),
        "hard_negative_candidate_id": block_field(block, "Hard-negative candidate id"),
        "hard_negative_proposed_label": proposed_label,
        "hard_negative_proposed_target": proposed_target,
        "hard_negative_review_instruction": block_field(block, "Hard-negative review instruction"),
        "source_turn": block_field(block, "Source turn"),
        "source_session": block_field(block, "Source session"),
        "source_seq": block_field(block, "Source seq"),
        "evidence_refs": evidence_refs_from_block(block),
    }


def insert_review_workload_summary(markdown: str, evaluation: dict[str, Any]) -> str:
    lines = markdown.rstrip().splitlines()
    if any(line == "Review workload:" for line in lines):
        return markdown.rstrip() + "\n"
    selected_index = next((index for index, line in enumerate(lines) if line.startswith("- Selected workspace sections:")), None)
    insert_at = selected_index + 1 if selected_index is not None else len(lines)
    missing_counts = evaluation.get("missing_field_counts") if isinstance(evaluation.get("missing_field_counts"), dict) else {}
    invalid_counts = evaluation.get("invalid_field_counts") if isinstance(evaluation.get("invalid_field_counts"), dict) else {}
    summary = [
        "",
        "Review workload:",
        "",
        f"- Review-complete rows: `{evaluation.get('review_complete', 0)}` / `{evaluation.get('sections', 0)}`",
        f"- Hard-negative-complete rows: `{evaluation.get('hard_negative_complete', 0)}` / `{evaluation.get('hard_negative_required', 0)}`",
        f"- Field completion: `{evaluation.get('completed_field_total', 0)}` / `{evaluation.get('review_field_total', 0)}` ({evaluation.get('field_completion_percent', 0)}%)",
        f"- Blocking fields: `{evaluation.get('blocking_field_total', 0)}`",
        f"- Missing fields: {format_field_counts({str(k): int(v) for k, v in missing_counts.items() if isinstance(v, int)})}",
        f"- Invalid fields: {format_field_counts({str(k): int(v) for k, v in invalid_counts.items() if isinstance(v, int)})}",
    ]
    return "\n".join([*lines[:insert_at], *summary, *lines[insert_at:]]).rstrip() + "\n"


def insert_post_edit_commands(markdown: str) -> str:
    lines = markdown.rstrip().splitlines()
    if any(line == "Post-edit commands:" for line in lines):
        return markdown.rstrip() + "\n"
    vocabulary_index = next((index for index, line in enumerate(lines) if line == "Editable field vocabulary:"), None)
    insert_at = vocabulary_index if vocabulary_index is not None else len(lines)
    commands = [
        "",
        "Post-edit commands:",
        "",
        "```sh",
        "bun run classifiers:blind-review-batch -- --mode=evaluate --batch=.ax/experiments/blind-review-batch-current.md --summary=.ax/experiments/blind-review-batch-current-eval-report.json --json",
        "bun run classifiers:blind-review-batch -- --mode=sync --workspace=.ax/experiments/blind-review-workspace-e63.md --batch=.ax/experiments/blind-review-batch-current.md --workspace-out=.ax/experiments/blind-review-workspace-current-preview.md --summary=.ax/experiments/blind-review-batch-current-sync-report.json --dry-run --json",
        "bun run classifiers:blind-review-refresh -- --json",
        "bun src/cli/index.ts classifiers lifecycle",
        "```",
    ]
    return "\n".join([*lines[:insert_at], *commands, *lines[insert_at:]]).rstrip() + "\n"


def insert_review_guidance(markdown: str) -> str:
    lines = markdown.rstrip().splitlines()
    if any(line == "Review label guidance:" for line in lines):
        return markdown.rstrip() + "\n"
    insert_at = next((index + 1 for index, line in enumerate(lines) if line.startswith("- Use `_none_`")), None)
    if insert_at is None:
        insert_at = next((index for index, line in enumerate(lines) if line.startswith("## ")), len(lines))
    guidance = [
        "",
        "Review label guidance:",
        "",
        *[f"- `{label}`: {LABEL_GUIDANCE[label]}" for label in ALLOWED_LABELS if label in LABEL_GUIDANCE],
        "",
        "Review target guidance:",
        "",
        *[f"- `{target}`: {TARGET_GUIDANCE[target]}" for target in TARGET_HINTS if target in TARGET_GUIDANCE],
        "",
        "Hard-negative status guidance:",
        "",
        *[f"- `{status}`: {HARD_NEGATIVE_STATUS_GUIDANCE[status]}" for status in sorted(VALID_STATUSES) if status in HARD_NEGATIVE_STATUS_GUIDANCE],
    ]
    return "\n".join([*lines[:insert_at], *guidance, *lines[insert_at:]]).rstrip() + "\n"


def replace_field_line(line: str, field: str, value: str) -> tuple[str, bool]:
    if not value:
        return line, False
    match = re.match(rf"^(\s*- {re.escape(field)}:\s*)(.*)$", line)
    if not match:
        return line, False
    current = strip_inline_code(match.group(2))
    if current not in {"__pending__", "_pending_", "pending_human_acceptance"}:
        return line, False
    return f"{match.group(1)}`{value}`", current != value


def draft_suggestion_block(block: str) -> tuple[str, dict[str, int]]:
    lines = block.splitlines()
    counts = {
        "prefilled_review_label": 0,
        "prefilled_review_target": 0,
        "prefilled_hard_negative_status": 0,
        "review_note_prompts": 0,
        "hard_negative_note_prompts": 0,
    }
    suggested_label = block_field(block, "Suggested label")
    suggested_target = block_field(block, "Suggested target")
    proposed_label, proposed_target = split_proposed_label_target(block_field(block, "Hard-negative proposed label/target"))
    for index, line in enumerate(lines):
        replaced, changed = replace_field_line(line, "Review label", suggested_label)
        if changed and suggested_label in ALLOWED_LABELS:
            lines[index] = replaced
            counts["prefilled_review_label"] += 1
            continue
        replaced, changed = replace_field_line(line, "Review target", suggested_target)
        if changed and suggested_target in TARGET_HINTS:
            lines[index] = replaced
            counts["prefilled_review_target"] += 1
            continue
        if proposed_label == "none" and proposed_target == "none":
            replaced, changed = replace_field_line(line, "Hard-negative status", "accepted")
            if changed:
                lines[index] = replaced
                counts["prefilled_hard_negative_status"] += 1
    lines, review_prompts = insert_note_prompts(lines, suggested_label, suggested_target, proposed_label, proposed_target)
    counts["review_note_prompts"] += review_prompts["review_note_prompts"]
    counts["hard_negative_note_prompts"] += review_prompts["hard_negative_note_prompts"]
    return "\n".join(lines).rstrip(), counts


def insert_note_prompts(
    lines: list[str],
    suggested_label: str,
    suggested_target: str,
    proposed_label: str,
    proposed_target: str,
) -> tuple[list[str], dict[str, int]]:
    if any(line.strip().startswith("- Review note prompt:") for line in lines):
        return lines, {"review_note_prompts": 0, "hard_negative_note_prompts": 0}
    result: list[str] = []
    counts = {"review_note_prompts": 0, "hard_negative_note_prompts": 0}
    for line in lines:
        result.append(line)
        stripped = line.strip()
        if stripped.startswith("- Review notes:"):
            result.append(f"- Review note prompt: Explain why `{suggested_label or 'none'}` / `{suggested_target or 'none'}` is right, or replace it with the corrected label/target.")
            counts["review_note_prompts"] += 1
        elif stripped.startswith("- Hard-negative notes:") and proposed_label == "none" and proposed_target == "none":
            result.append("- Hard-negative note prompt: Explain why this row is ordinary control/context and should train the `none` boundary, or change status to `rejected`.")
            counts["hard_negative_note_prompts"] += 1
    return result, counts


def insert_suggestion_draft_notice(markdown: str) -> str:
    lines = markdown.rstrip().splitlines()
    if any(line == "Suggestion draft notice:" for line in lines):
        return markdown.rstrip() + "\n"
    workload_index = next((index for index, line in enumerate(lines) if line == "Review workload:"), None)
    insert_at = workload_index if workload_index is not None else next((index for index, line in enumerate(lines) if line.startswith("## ")), len(lines))
    notice = [
        "",
        "Suggestion draft notice:",
        "",
        "- This is a reviewer assist, not an authoritative review.",
        "- Suggested labels, targets, and obvious `none` hard-negative statuses may be prefilled.",
        "- Human review notes and hard-negative notes are still required before sync.",
    ]
    return "\n".join([*lines[:insert_at], *notice, *lines[insert_at:]]).rstrip() + "\n"


def insert_suggestion_draft_commands(markdown: str) -> str:
    lines = markdown.rstrip().splitlines()
    if any(line == "Suggestion draft post-edit commands:" for line in lines):
        return markdown.rstrip() + "\n"
    notice_index = next((index for index, line in enumerate(lines) if line == "Suggestion draft notice:"), None)
    insert_at = notice_index if notice_index is not None else next((index for index, line in enumerate(lines) if line == "Post-edit commands:"), len(lines))
    commands = [
        "",
        "Suggestion draft post-edit commands:",
        "",
        "```sh",
        "bun run classifiers:blind-review-batch -- --mode=evaluate --batch=.ax/experiments/blind-review-batch-current-suggestion-draft.md --summary=.ax/experiments/blind-review-batch-current-suggestion-draft-eval-report.json --json",
        "bun run classifiers:blind-review-batch -- --mode=promote-draft --batch=.ax/experiments/blind-review-batch-current-suggestion-draft.md --out=.ax/experiments/blind-review-batch-current.md --summary=.ax/experiments/blind-review-batch-current-promotion-report.json --json",
        "bun run classifiers:blind-review-refresh -- --json",
        "bun src/cli/index.ts classifiers lifecycle",
        "```",
    ]
    return "\n".join([*lines[:insert_at], *commands, *lines[insert_at:]]).rstrip() + "\n"


def draft_suggestions(batch: str) -> tuple[str, dict[str, Any]]:
    before_eval = evaluate_batch(batch)
    preamble, blocks = split_workspace(batch)
    drafted_blocks: list[str] = []
    totals = Counter()
    for _ordinal, block in blocks:
        drafted, counts = draft_suggestion_block(block)
        drafted_blocks.append(drafted)
        totals.update(counts)
    drafted = "\n\n".join(part for part in [preamble, *drafted_blocks] if part).rstrip() + "\n"
    drafted = insert_suggestion_draft_notice(drafted)
    drafted = insert_suggestion_draft_commands(drafted)
    after_eval = evaluate_batch(drafted)
    report = {
        "schema": "ax.blind_review_batch_suggestion_draft_report.v1",
        "source_batch_sha256": sha256_text(batch),
        "draft_batch_sha256": sha256_text(drafted),
        "sections": after_eval["sections"],
        "prefilled_review_label": totals["prefilled_review_label"],
        "prefilled_review_target": totals["prefilled_review_target"],
        "prefilled_hard_negative_status": totals["prefilled_hard_negative_status"],
        "review_note_prompts": totals["review_note_prompts"],
        "hard_negative_note_prompts": totals["hard_negative_note_prompts"],
        "before_blocking_field_total": before_eval["blocking_field_total"],
        "after_blocking_field_total": after_eval["blocking_field_total"],
        "before_field_completion_percent": before_eval["field_completion_percent"],
        "after_field_completion_percent": after_eval["field_completion_percent"],
        "after_missing_field_counts": after_eval["missing_field_counts"],
        "after_invalid_field_counts": after_eval["invalid_field_counts"],
        "after_decision": after_eval["decision"],
        "failures": [],
        "decision": "draft_ready_for_human_notes",
    }
    return drafted, report


def promote_draft(draft: str) -> tuple[str, dict[str, Any]]:
    evaluation = evaluate_batch(draft)
    failures = [] if evaluation["decision"] == "ready_for_batch_sync" else ["draft batch review is incomplete"]
    report = {
        "schema": "ax.blind_review_batch_draft_promotion_report.v1",
        "draft_batch_sha256": sha256_text(draft),
        "sections": evaluation["sections"],
        "review_task_total": evaluation["review_task_total"],
        "blocking_field_total": evaluation["blocking_field_total"],
        "missing_field_counts": evaluation["missing_field_counts"],
        "invalid_field_counts": evaluation["invalid_field_counts"],
        "draft_eval_decision": evaluation["decision"],
        "failures": failures,
        "decision": "ready_for_current_batch_write" if not failures else "needs_human_notes",
    }
    return draft.rstrip() + "\n", report


def sync_batch(workspace: str, batch: str, workspace_out: str, dry_run: bool, allow_incomplete: bool = False) -> tuple[str, dict[str, Any]]:
    preamble, workspace_blocks = split_workspace(workspace)
    batch_blocks = section_blocks(batch)
    batch_eval = evaluate_batch(batch)
    workspace_ordinals = {ordinal for ordinal, _ in workspace_blocks}
    replaced: list[int] = []
    merged_blocks: list[str] = []

    for ordinal, block in workspace_blocks:
        replacement = batch_blocks.get(ordinal)
        if replacement is None:
            merged_blocks.append(block)
            continue
        merged_blocks.append(replacement)
        replaced.append(ordinal)

    missing_workspace_ordinals = sorted(ordinal for ordinal in batch_blocks if ordinal not in workspace_ordinals)
    failures = [f"batch section missing from workspace: {ordinal}" for ordinal in missing_workspace_ordinals]
    if batch_eval["decision"] != "ready_for_batch_sync" and not allow_incomplete:
        failures.append("batch review is incomplete")
    decision = "ready_for_workspace_dry_run" if replaced and not failures else (
        "needs_batch_review" if batch_eval["decision"] != "ready_for_batch_sync" and not allow_incomplete else "needs_batch_sync_inputs"
    )
    parts = [part for part in [preamble, *merged_blocks] if part]
    merged = "\n\n".join(parts).rstrip() + "\n"
    summary = {
        "schema": "ax.blind_review_batch_sync_report.v1",
        "workspace_sha256": sha256_text(workspace),
        "batch_sha256": sha256_text(batch),
        "replaced_ordinals": replaced,
        "sections": len(replaced),
        "missing_workspace_ordinals": missing_workspace_ordinals,
        "batch_eval_decision": batch_eval["decision"],
        "allow_incomplete": allow_incomplete,
        "failures": failures,
        "workspace_out": workspace_out,
        "dry_run": dry_run,
        "decision": decision,
    }
    return merged, summary


def main() -> int:
    args = parse_args()
    if args.mode == "generate":
        packet = load_json(args.packet) if Path(args.packet).exists() else {"items": []}
        markdown, report = render_batch(
            Path(args.workspace).read_text(),
            load_json(args.report),
            args.limit,
            packet_context_by_id(packet),
        )
        markdown = insert_review_guidance(insert_post_edit_commands(insert_review_workload_summary(markdown, evaluate_batch(markdown))))
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(markdown)
        ready_decision = "ready_for_batch_review"
    elif args.mode == "evaluate":
        batch_path = args.batch or args.out
        report = evaluate_batch(Path(batch_path).read_text())
        ready_decision = "ready_for_batch_sync"
    elif args.mode == "draft-suggestions":
        batch_path = args.batch or args.out
        markdown, report = draft_suggestions(Path(batch_path).read_text())
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(markdown)
        ready_decision = "draft_ready_for_human_notes"
    elif args.mode == "promote-draft":
        batch_path = args.batch or args.out
        markdown, report = promote_draft(Path(batch_path).read_text())
        if report["decision"] == "ready_for_current_batch_write":
            out = Path(args.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(markdown)
        ready_decision = "ready_for_current_batch_write"
    else:
        batch_path = args.batch or args.out
        workspace_out = args.workspace_out or args.workspace
        markdown, report = sync_batch(
            Path(args.workspace).read_text(),
            Path(batch_path).read_text(),
            workspace_out,
            args.dry_run,
            args.allow_incomplete,
        )
        if not args.dry_run and report["decision"] == "ready_for_workspace_dry_run":
            out = Path(workspace_out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(markdown)
        ready_decision = "ready_for_workspace_dry_run"
    write_json(args.summary, report)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"blind review batch {args.mode}")
        print(f"sections: {report['sections']}")
        print(f"decision: {report['decision']}")
        if args.mode in {"generate", "draft-suggestions", "promote-draft"}:
            print(f"out: {args.out}")
        else:
            print(f"workspace_out: {args.workspace_out or args.workspace}")
    return 0 if report["decision"] == ready_decision else 1


if __name__ == "__main__":
    raise SystemExit(main())
