#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).with_name("blind_review_batch.py")
spec = importlib.util.spec_from_file_location("session_section_blind_review_batch", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_review_batch"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindReviewBatchTest(unittest.TestCase):
    def test_section_blocks_indexes_workspace_sections_by_ordinal(self) -> None:
        blocks = module.section_blocks("# Title\n\n## 1. blind/a\n\nbody a\n\n## 2. blind/b\n\nbody b\n")

        self.assertIn("body a", blocks[1])
        self.assertIn("body b", blocks[2])

    def test_selected_ordinals_deduplicates_label_and_hard_negative_refs(self) -> None:
        report = {
            "progress": {
                "blind_label_next_pending_refs": [{"ordinal": 2, "id": "blind/b"}],
                "hard_negative_next_pending_refs": [{"ordinal": 2, "id": "candidate/b"}, {"ordinal": 3, "id": "candidate/c"}],
            }
        }

        self.assertEqual(module.selected_ordinals(report, 5), [2, 3])

    def test_render_batch_resolves_progress_refs_by_workspace_id_before_stale_ordinals(self) -> None:
        workspace = "# Title\n\n## 1. blind/reviewed\n\nold\n\n## 2. blind/pending\n\nnew\n"
        report = {
            "progress": {
                "blind_label_next_pending_refs": [{"ordinal": 1, "id": "blind/pending"}],
                "hard_negative_next_pending_refs": [{"ordinal": 1, "id": "candidate/pending", "source_blind_id": "blind/pending"}],
            }
        }

        markdown, summary = module.render_batch(workspace, report, 5)

        self.assertIn("## 2. blind/pending", markdown)
        self.assertIn("new", markdown)
        self.assertNotIn("## 1. blind/reviewed", markdown)
        self.assertEqual(summary["selected_ordinals"], [2])

    def test_render_batch_extracts_only_selected_sections(self) -> None:
        workspace = "# Title\n\n## 1. blind/a\n\nbody a\n\n## 2. blind/b\n\nbody b\n"
        report = {"progress": {"blind_label_next_pending_refs": [{"ordinal": 2, "id": "blind/b"}]}}

        markdown, summary = module.render_batch(workspace, report, 5)

        self.assertNotIn("body a", markdown)
        self.assertIn("body b", markdown)
        self.assertEqual(summary["decision"], "ready_for_batch_review")
        self.assertEqual(summary["selected_ordinals"], [2])
        self.assertEqual(summary["workspace_sha256"], module.sha256_text(workspace))
        self.assertTrue(summary["vocabulary_included"])
        self.assertEqual(summary["allowed_label_count"], 5)
        self.assertEqual(summary["allowed_target_count"], 10)
        self.assertEqual(summary["allowed_hard_negative_status_count"], 3)
        self.assertIn("Editable field vocabulary:", markdown)
        self.assertIn("Review labels:", markdown)
        self.assertIn("Review targets:", markdown)
        self.assertIn("Hard-negative statuses:", markdown)
        self.assertIn("`none`", markdown)

    def test_render_batch_enriches_sections_with_packet_context(self) -> None:
        workspace = """
# Title

## 1. blind/a

- Review label: `__pending__`
- Review target: `__pending__`
- Review notes: _pending_
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `pending_human_acceptance`
- Hard-negative notes: _pending_
- Suggested label: `environment_or_preference_signal`
- Suggested target: `workflow_state`
- Source window: `event_window:a`
"""
        report = {"progress": {"blind_label_next_pending_refs": [{"ordinal": 1, "id": "blind/a"}]}}

        markdown, summary = module.render_batch(
            workspace,
            report,
            5,
            {
                "blind/a": {
                    "hard_negative_status": "pending_human_acceptance",
                    "hard_negative_proposed_label": "none",
                    "hard_negative_proposed_target": "none",
                    "hard_negative_review_instruction": "Accept only if this is ordinary control flow.",
                    "confidence_bucket": "medium",
                    "binary_confidence": 0.9,
                    "family_confidence": 0.7,
                    "source_turn": "turn:a",
                    "source_session": "session:a",
                    "source_seq": 1,
                    "approx_tokens": 10,
                    "evidence_refs": ["turn:a"],
                }
            },
        )

        self.assertEqual(summary["context_enriched_sections"], 1)
        self.assertIn("- Hard-negative proposed label/target: `none` / `none`", markdown)
        self.assertIn("- Hard-negative review instruction: Accept only if this is ordinary control flow.", markdown)
        self.assertIn("- Confidence bucket: `medium`", markdown)
        self.assertIn("- Evidence: `turn:a`", markdown)

    def test_sync_batch_replaces_only_matching_sections(self) -> None:
        workspace = "# Title\n\n## 1. blind/a\n\nold a\n\n## 2. blind/b\n\nold b\n\n## 3. blind/c\n\nold c\n"
        batch = """
# Batch

## 2. blind/b

- Review label: `none`
- Review target: `none`
- Review notes: control turn
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
"""

        merged, summary = module.sync_batch(workspace, batch, ".ax/workspace.md", False)

        self.assertIn("old a", merged)
        self.assertIn("Review notes: control turn", merged)
        self.assertIn("old c", merged)
        self.assertNotIn("old b", merged)
        self.assertEqual(summary["replaced_ordinals"], [2])
        self.assertEqual(summary["decision"], "ready_for_workspace_dry_run")
        self.assertEqual(summary["workspace_sha256"], module.sha256_text(workspace))
        self.assertEqual(summary["batch_sha256"], module.sha256_text(batch))

    def test_sync_batch_reports_batch_sections_missing_from_workspace(self) -> None:
        workspace = "# Title\n\n## 1. blind/a\n\nold a\n"
        batch = """
# Batch

## 2. blind/b

- Review label: `none`
- Review target: `none`
- Review notes: control turn
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
"""

        _merged, summary = module.sync_batch(workspace, batch, ".ax/workspace.md", False)

        self.assertEqual(summary["replaced_ordinals"], [])
        self.assertEqual(summary["missing_workspace_ordinals"], [2])
        self.assertEqual(summary["decision"], "needs_batch_sync_inputs")

    def test_sync_batch_blocks_incomplete_reviews_by_default(self) -> None:
        workspace = "# Title\n\n## 1. blind/a\n\nold a\n"
        batch = """
# Batch

## 1. blind/a

- Review label: `__pending__`
- Review target: `__pending__`
- Review notes: _pending_
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
"""

        _merged, summary = module.sync_batch(workspace, batch, ".ax/workspace.md", False)

        self.assertEqual(summary["decision"], "needs_batch_review")
        self.assertEqual(summary["batch_eval_decision"], "needs_batch_review")
        self.assertFalse(summary["allow_incomplete"])
        self.assertIn("batch review is incomplete", summary["failures"])

    def test_sync_batch_allows_explicit_incomplete_mechanical_preview(self) -> None:
        workspace = "# Title\n\n## 1. blind/a\n\nold a\n"
        batch = """
# Batch

## 1. blind/a

- Review label: `__pending__`
- Review target: `__pending__`
- Review notes: _pending_
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
"""

        _merged, summary = module.sync_batch(workspace, batch, ".ax/workspace.md", False, allow_incomplete=True)

        self.assertEqual(summary["decision"], "ready_for_workspace_dry_run")
        self.assertEqual(summary["batch_eval_decision"], "needs_batch_review")
        self.assertTrue(summary["allow_incomplete"])

    def test_evaluate_batch_blocks_pending_review_fields(self) -> None:
        batch = """
# Batch

## 1. blind/a

- Review label: `__pending__`
- Review target: `__pending__`
- Review notes: _pending_
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `pending_human_acceptance`
- Hard-negative notes: _pending_
- Hard-negative proposed label/target: `none` / `none`
- Hard-negative review instruction: Accept only if this is ordinary control flow.
- Suggested label: `environment_or_preference_signal`
- Suggested target: `workflow_state`
- Confidence bucket: `medium`
- Risk reasons: `possible_none_control_turn`, `medium_confidence`
- Source turn: `turn:a`
- Source session: `session:a`
- Source seq: `7`
- Evidence: `turn:previous`, `tool_call:failure`
"""

        report = module.evaluate_batch(batch)

        self.assertEqual(report["decision"], "needs_batch_review")
        self.assertEqual(report["batch_sha256"], module.sha256_text(batch))
        self.assertEqual(report["review_pending"], 1)
        self.assertEqual(report["hard_negative_pending"], 1)
        self.assertEqual(
            report["incomplete_refs"][0]["missing"],
            ["review_label", "review_target", "review_notes", "hard_negative_status", "hard_negative_notes"],
        )
        self.assertEqual(report["incomplete_refs"][0]["invalid"], [])
        self.assertEqual(
            report["missing_field_counts"],
            {
                "hard_negative_notes": 1,
                "hard_negative_status": 1,
                "review_label": 1,
                "review_notes": 1,
                "review_target": 1,
            },
        )
        self.assertEqual(report["missing_field_total"], 5)
        self.assertEqual(report["invalid_field_total"], 0)
        self.assertEqual(report["blocking_field_total"], 5)
        self.assertEqual(report["completed_field_total"], 0)
        self.assertEqual(report["review_field_total"], 5)
        self.assertEqual(report["field_completion_percent"], 0.0)
        self.assertEqual(report["row_completion_percent"], 0.0)
        self.assertEqual(report["invalid_field_counts"], {})
        self.assertEqual(report["review_task_total"], 1)
        self.assertEqual(report["review_tasks"][0]["ordinal"], 1)
        self.assertEqual(report["review_tasks"][0]["suggested_label"], "environment_or_preference_signal")
        self.assertEqual(report["review_tasks"][0]["suggested_target"], "workflow_state")
        self.assertEqual(report["review_tasks"][0]["confidence_bucket"], "medium")
        self.assertEqual(report["review_tasks"][0]["risk_reasons"], ["possible_none_control_turn", "medium_confidence"])
        self.assertEqual(report["review_tasks"][0]["hard_negative_candidate_id"], "pending-hard-negative/blind/a")
        self.assertEqual(report["review_tasks"][0]["hard_negative_proposed_label"], "none")
        self.assertEqual(report["review_tasks"][0]["hard_negative_proposed_target"], "none")
        self.assertEqual(report["review_tasks"][0]["hard_negative_review_instruction"], "Accept only if this is ordinary control flow.")
        self.assertEqual(report["review_tasks"][0]["source_turn"], "turn:a")
        self.assertEqual(report["review_tasks"][0]["source_session"], "session:a")
        self.assertEqual(report["review_tasks"][0]["source_seq"], "7")
        self.assertEqual(report["review_tasks"][0]["evidence_refs"], ["turn:previous", "tool_call:failure"])

    def test_insert_review_workload_summary_adds_header_checklist(self) -> None:
        batch = """
# Blind Review Batch

- Selected workspace sections: `1`

Editable field vocabulary:

## 1. blind/a

- Review label: `__pending__`
- Review target: `__pending__`
- Review notes: _pending_
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `pending_human_acceptance`
- Hard-negative notes: _pending_
"""

        enriched = module.insert_review_workload_summary(batch, module.evaluate_batch(batch))

        self.assertIn("Review workload:", enriched)
        self.assertIn("- Review-complete rows: `0` / `1`", enriched)
        self.assertIn("- Hard-negative-complete rows: `0` / `1`", enriched)
        self.assertIn("- Field completion: `0` / `5` (0.0%)", enriched)
        self.assertIn("- Blocking fields: `5`", enriched)
        self.assertIn(
            "- Missing fields: Hard-negative notes: 1, Hard-negative status: 1, Review label: 1, Review notes: 1, Review target: 1",
            enriched,
        )
        self.assertEqual(enriched.count("Review workload:"), 1)
        self.assertEqual(module.insert_review_workload_summary(enriched, module.evaluate_batch(enriched)).count("Review workload:"), 1)

    def test_insert_post_edit_commands_adds_validation_commands_before_vocabulary(self) -> None:
        batch = """
# Blind Review Batch

Review workload:

Editable field vocabulary:
"""

        enriched = module.insert_post_edit_commands(batch)

        self.assertIn("Post-edit commands:", enriched)
        self.assertLess(enriched.index("Post-edit commands:"), enriched.index("Editable field vocabulary:"))
        self.assertIn("bun run classifiers:blind-review-batch -- --mode=evaluate", enriched)
        self.assertIn("bun run classifiers:blind-review-batch -- --mode=sync", enriched)
        self.assertIn("bun run classifiers:blind-review-refresh -- --json", enriched)
        self.assertIn("bun src/cli/index.ts classifiers lifecycle", enriched)
        self.assertEqual(enriched.count("Post-edit commands:"), 1)
        self.assertEqual(module.insert_post_edit_commands(enriched).count("Post-edit commands:"), 1)

    def test_insert_review_guidance_adds_label_target_status_help_before_sections(self) -> None:
        batch = """
# Blind Review Batch

Editable field vocabulary:

- Review labels: `approval`, `none`
- Review targets: `continue`, `none`
- Hard-negative statuses: `accepted`, `pending_human_acceptance`, `rejected`
- Use `_none_` only when the section has no hard-negative candidate.

## 1. blind/a
"""

        enriched = module.insert_review_guidance(batch)

        self.assertIn("Review label guidance:", enriched)
        self.assertIn("`correction_or_rejection_signal`: User corrects", enriched)
        self.assertIn("Review target guidance:", enriched)
        self.assertIn("`benchmark_required`: Asks for tests", enriched)
        self.assertIn("Hard-negative status guidance:", enriched)
        self.assertIn("`accepted`: Row is ordinary none/control", enriched)
        self.assertLess(enriched.index("Review label guidance:"), enriched.index("## 1. blind/a"))
        self.assertEqual(enriched.count("Review label guidance:"), 1)
        self.assertEqual(module.insert_review_guidance(enriched).count("Review label guidance:"), 1)

    def test_draft_suggestions_prefills_labels_targets_and_obvious_none_status_only(self) -> None:
        batch = """
# Blind Review Batch

## 1. blind/a

- Review label: `__pending__`
- Review target: `__pending__`
- Review notes: _pending_
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `pending_human_acceptance`
- Hard-negative notes: _pending_
- Hard-negative proposed label/target: `none` / `none`
- Suggested label: `environment_or_preference_signal`
- Suggested target: `workflow_state`

## 2. blind/b

- Review label: `__pending__`
- Review target: `__pending__`
- Review notes: _pending_
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
- Suggested label: `verification_or_recovery_signal`
- Suggested target: `benchmark_required`
"""

        drafted, report = module.draft_suggestions(batch)

        self.assertIn("Suggestion draft notice:", drafted)
        self.assertIn("- Review label: `environment_or_preference_signal`", drafted)
        self.assertIn("- Review target: `workflow_state`", drafted)
        self.assertIn("- Hard-negative status: `accepted`", drafted)
        self.assertIn("- Review label: `verification_or_recovery_signal`", drafted)
        self.assertIn("- Review target: `benchmark_required`", drafted)
        self.assertIn("Suggestion draft post-edit commands:", drafted)
        self.assertLess(drafted.index("Suggestion draft post-edit commands:"), drafted.index("Suggestion draft notice:"))
        self.assertIn("--mode=evaluate --batch=.ax/experiments/blind-review-batch-current-suggestion-draft.md", drafted)
        self.assertIn("--mode=promote-draft --batch=.ax/experiments/blind-review-batch-current-suggestion-draft.md", drafted)
        self.assertIn("- Review notes: _pending_", drafted)
        self.assertIn("- Review note prompt: Explain why `environment_or_preference_signal` / `workflow_state` is right", drafted)
        self.assertIn("- Hard-negative notes: _pending_", drafted)
        self.assertIn("- Hard-negative note prompt: Explain why this row is ordinary control/context", drafted)
        self.assertEqual(report["decision"], "draft_ready_for_human_notes")
        self.assertEqual(report["prefilled_review_label"], 2)
        self.assertEqual(report["prefilled_review_target"], 2)
        self.assertEqual(report["prefilled_hard_negative_status"], 1)
        self.assertEqual(report["review_note_prompts"], 2)
        self.assertEqual(report["hard_negative_note_prompts"], 1)
        self.assertEqual(report["before_blocking_field_total"], 8)
        self.assertEqual(report["after_blocking_field_total"], 3)
        self.assertEqual(report["after_missing_field_counts"], {"hard_negative_notes": 1, "review_notes": 2})
        self.assertEqual(module.draft_suggestions(drafted)[1]["prefilled_review_label"], 0)
        self.assertEqual(module.draft_suggestions(drafted)[1]["review_note_prompts"], 0)
        self.assertEqual(drafted.count("Suggestion draft post-edit commands:"), 1)
        self.assertEqual(module.draft_suggestions(drafted)[0].count("Suggestion draft post-edit commands:"), 1)

    def test_promote_draft_blocks_until_draft_eval_is_ready(self) -> None:
        draft = """
# Blind Review Batch

## 1. blind/a

- Review label: `none`
- Review target: `none`
- Review notes: _pending_
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
"""

        _markdown, report = module.promote_draft(draft)

        self.assertEqual(report["decision"], "needs_human_notes")
        self.assertEqual(report["draft_eval_decision"], "needs_batch_review")
        self.assertEqual(report["review_task_total"], 1)
        self.assertEqual(report["blocking_field_total"], 1)
        self.assertEqual(report["missing_field_counts"], {"review_notes": 1})
        self.assertIn("draft batch review is incomplete", report["failures"])

    def test_promote_draft_allows_ready_draft_for_current_batch_write(self) -> None:
        draft = """
# Blind Review Batch

## 1. blind/a

- Review label: `none`
- Review target: `none`
- Review notes: ordinary workflow control
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
"""

        markdown, report = module.promote_draft(draft)

        self.assertEqual(report["decision"], "ready_for_current_batch_write")
        self.assertEqual(report["draft_eval_decision"], "ready_for_batch_sync")
        self.assertEqual(report["review_task_total"], 0)
        self.assertEqual(report["blocking_field_total"], 0)
        self.assertEqual(report["failures"], [])
        self.assertIn("Review notes: ordinary workflow control", markdown)

    def test_evaluate_batch_blocks_invalid_review_values(self) -> None:
        batch = """
# Batch

## 1. blind/a

- Review label: `made_up_label`
- Review target: `made_up_target`
- Review notes: invalid values should fail before sync
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `maybe`
- Hard-negative notes: invalid status should fail
"""

        report = module.evaluate_batch(batch)

        self.assertEqual(report["decision"], "needs_batch_review")
        self.assertEqual(report["review_pending"], 0)
        self.assertEqual(report["hard_negative_pending"], 1)
        self.assertEqual(
            report["invalid_refs"][0]["invalid"],
            ["review_label", "review_target", "hard_negative_status"],
        )
        self.assertEqual(
            report["invalid_field_counts"],
            {"hard_negative_status": 1, "review_label": 1, "review_target": 1},
        )
        self.assertEqual(report["missing_field_total"], 0)
        self.assertEqual(report["invalid_field_total"], 3)
        self.assertEqual(report["blocking_field_total"], 3)
        self.assertEqual(report["completed_field_total"], 2)
        self.assertEqual(report["review_field_total"], 5)
        self.assertEqual(report["field_completion_percent"], 40.0)
        self.assertIn("batch section has invalid fields: 1", report["failures"])

    def test_evaluate_batch_blocks_non_substantive_review_notes(self) -> None:
        batch = """
# Batch

## 1. blind/a

- Review label: `none`
- Review target: `none`
- Review notes: ok
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `accepted`
- Hard-negative notes: yep
"""

        report = module.evaluate_batch(batch)

        self.assertEqual(report["decision"], "needs_batch_review")
        self.assertEqual(report["review_pending"], 1)
        self.assertEqual(report["hard_negative_pending"], 1)
        self.assertEqual(report["invalid_refs"][0]["invalid"], ["review_notes", "hard_negative_notes"])
        self.assertEqual(report["invalid_field_counts"], {"hard_negative_notes": 1, "review_notes": 1})
        self.assertEqual(report["missing_field_total"], 0)
        self.assertEqual(report["invalid_field_total"], 2)
        self.assertEqual(report["blocking_field_total"], 2)
        self.assertEqual(report["completed_field_total"], 3)
        self.assertEqual(report["review_field_total"], 5)
        self.assertEqual(report["field_completion_percent"], 60.0)
        self.assertIn("batch section has invalid fields: 1", report["failures"])

    def test_evaluate_batch_ready_when_reviews_and_required_hard_negatives_are_done(self) -> None:
        batch = """
# Batch

## 1. blind/a

- Review label: `none`
- Review target: `none`
- Review notes: ordinary workflow control
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `accepted`
- Hard-negative notes: useful boundary

## 2. blind/b

- Review label: `verification_or_recovery_signal`
- Review target: `benchmark_required`
- Review notes: asks for adversarial review
- Hard-negative candidate id: `_none_`
- Hard-negative status: `_none_`
- Hard-negative notes: _pending_
"""

        report = module.evaluate_batch(batch)

        self.assertEqual(report["decision"], "ready_for_batch_sync")
        self.assertEqual(report["review_complete"], 2)
        self.assertEqual(report["review_pending"], 0)
        self.assertEqual(report["hard_negative_required"], 1)
        self.assertEqual(report["hard_negative_complete"], 1)
        self.assertEqual(report["hard_negative_pending"], 0)
        self.assertEqual(report["missing_field_total"], 0)
        self.assertEqual(report["invalid_field_total"], 0)
        self.assertEqual(report["blocking_field_total"], 0)
        self.assertEqual(report["completed_field_total"], 8)
        self.assertEqual(report["review_field_total"], 8)
        self.assertEqual(report["field_completion_percent"], 100.0)
        self.assertEqual(report["row_completion_percent"], 100.0)
        self.assertEqual(report["missing_field_counts"], {})
        self.assertEqual(report["invalid_field_counts"], {})
        self.assertEqual(report["invalid_refs"], [])
        self.assertEqual(report["incomplete_refs"], [])
        self.assertEqual(report["review_task_total"], 0)
        self.assertEqual(report["review_tasks"], [])


if __name__ == "__main__":
    unittest.main()
