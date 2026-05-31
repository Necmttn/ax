#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_workflow_status.py")
spec = importlib.util.spec_from_file_location("session_section_blind_workflow_status", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_workflow_status"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindWorkflowStatusTest(unittest.TestCase):
    def test_stage_from_report_extracts_decision_and_blocked_state(self) -> None:
        stage = module.stage_from_report("blind_labels", {"decision": "needs_blind_label_review", "failures": ["pending"]})

        self.assertEqual(stage["name"], "blind_labels")
        self.assertEqual(stage["decision"], "needs_blind_label_review")
        self.assertFalse(stage["ready"])
        self.assertEqual(stage["failures"], ["pending"])

    def test_stage_from_report_marks_ready_decisions(self) -> None:
        stage = module.stage_from_report("suggestions", {"decision": "ready_for_human_acceptance"})

        self.assertTrue(stage["ready"])

    def test_stage_from_report_preserves_review_workspace_details(self) -> None:
        stage = module.stage_from_report(
            "review_workspace",
            {
                "decision": "needs_human_review",
                "blind_label_pending": 40,
                "hard_negative_pending": 20,
                "progress": {
                    "blind_label_next_pending_ids": ["blind/a"],
                },
                "workspace_update_failures": [],
                "dry_run": True,
            },
        )

        self.assertEqual(stage["details"]["blind_label_pending"], 40)
        self.assertEqual(stage["details"]["hard_negative_pending"], 20)
        self.assertEqual(stage["details"]["progress"]["blind_label_next_pending_ids"], ["blind/a"])
        self.assertEqual(stage["details"]["workspace_update_failures"], [])
        self.assertTrue(stage["details"]["dry_run"])

    def test_stage_from_report_preserves_post_review_runner_details(self) -> None:
        stage = module.stage_from_report(
            "post_review_runner",
            {
                "decision": "needs_human_review",
                "skipped": ["blind_roundtrip"],
                "stages": {
                    "workspace": {
                        "blind_label_pending": 40,
                        "workspace_update_failures": [],
                    }
                },
            },
        )

        self.assertEqual(stage["details"]["skipped"], ["blind_roundtrip"])
        self.assertEqual(stage["details"]["stages"]["workspace"]["blind_label_pending"], 40)

    def test_stage_from_report_preserves_review_batch_details(self) -> None:
        stage = module.stage_from_report(
            "review_batch",
            {
                "decision": "ready_for_batch_review",
                "selected_ordinals": [1, 2, 3],
                "sections": 3,
                "context_enriched_sections": 3,
                "vocabulary_included": True,
                "allowed_label_count": 5,
                "allowed_target_count": 10,
                "allowed_hard_negative_status_count": 3,
                "missing_ordinals": [],
            },
        )

        self.assertTrue(stage["ready"])
        self.assertEqual(stage["details"]["selected_ordinals"], [1, 2, 3])
        self.assertEqual(stage["details"]["sections"], 3)
        self.assertEqual(stage["details"]["context_enriched_sections"], 3)
        self.assertTrue(stage["details"]["vocabulary_included"])
        self.assertEqual(stage["details"]["allowed_label_count"], 5)
        self.assertEqual(stage["details"]["allowed_target_count"], 10)
        self.assertEqual(stage["details"]["allowed_hard_negative_status_count"], 3)

    def test_stage_from_report_preserves_review_batch_sync_details(self) -> None:
        stage = module.stage_from_report(
            "review_batch_sync",
            {
                "decision": "ready_for_workspace_dry_run",
                "replaced_ordinals": [1, 2, 3],
                "sections": 3,
                "missing_workspace_ordinals": [],
                "batch_eval_decision": "ready_for_batch_sync",
                "allow_incomplete": False,
                "workspace_out": ".ax/experiments/blind-review-workspace-e79-merged-preview.md",
                "dry_run": False,
            },
        )

        self.assertTrue(stage["ready"])
        self.assertEqual(stage["details"]["replaced_ordinals"], [1, 2, 3])
        self.assertEqual(stage["details"]["missing_workspace_ordinals"], [])
        self.assertEqual(stage["details"]["batch_eval_decision"], "ready_for_batch_sync")
        self.assertFalse(stage["details"]["allow_incomplete"])
        self.assertEqual(stage["details"]["workspace_out"], ".ax/experiments/blind-review-workspace-e79-merged-preview.md")

    def test_stage_from_report_preserves_review_batch_eval_details(self) -> None:
        stage = module.stage_from_report(
            "review_batch_eval",
            {
                "decision": "needs_batch_review",
                "batch_sha256": "abc123",
                "sections": 5,
                "review_complete": 0,
                "review_pending": 5,
                "hard_negative_required": 3,
                "hard_negative_complete": 0,
                "hard_negative_pending": 3,
                "missing_field_total": 10,
                "invalid_field_total": 1,
                "blocking_field_total": 11,
                "completed_field_total": 4,
                "review_field_total": 15,
                "field_completion_percent": 26.7,
                "row_completion_percent": 12.5,
                "missing_field_counts": {"review_label": 5, "review_target": 5},
                "invalid_field_counts": {"review_notes": 1},
                "invalid_refs": [{"ordinal": 1, "invalid": ["review_notes"]}],
                "incomplete_refs": [{"ordinal": 1, "missing": ["review_label"], "invalid": ["review_notes"]}],
                "review_task_total": 1,
                "review_tasks": [{"ordinal": 1, "id": "blind-row-1", "suggested_label": "none"}],
            },
        )

        self.assertFalse(stage["ready"])
        self.assertEqual(stage["details"]["review_pending"], 5)
        self.assertEqual(stage["details"]["batch_sha256"], "abc123")
        self.assertEqual(stage["details"]["hard_negative_pending"], 3)
        self.assertEqual(stage["details"]["missing_field_total"], 10)
        self.assertEqual(stage["details"]["invalid_field_total"], 1)
        self.assertEqual(stage["details"]["blocking_field_total"], 11)
        self.assertEqual(stage["details"]["completed_field_total"], 4)
        self.assertEqual(stage["details"]["review_field_total"], 15)
        self.assertEqual(stage["details"]["field_completion_percent"], 26.7)
        self.assertEqual(stage["details"]["row_completion_percent"], 12.5)
        self.assertEqual(stage["details"]["missing_field_counts"], {"review_label": 5, "review_target": 5})
        self.assertEqual(stage["details"]["invalid_field_counts"], {"review_notes": 1})
        self.assertEqual(stage["details"]["invalid_refs"], [{"ordinal": 1, "invalid": ["review_notes"]}])
        self.assertEqual(stage["details"]["incomplete_refs"], [{"ordinal": 1, "missing": ["review_label"], "invalid": ["review_notes"]}])
        self.assertEqual(stage["details"]["review_task_total"], 1)
        self.assertEqual(stage["details"]["review_tasks"], [{"ordinal": 1, "id": "blind-row-1", "suggested_label": "none"}])

    def test_stage_from_report_preserves_review_refresh_details(self) -> None:
        stage = module.stage_from_report(
            "review_refresh",
            {
                "decision": "refreshed",
                "batch": ".ax/batch.md",
                "batch_report": ".ax/batch-report.json",
                "batch_eval": ".ax/batch-eval.json",
                "batch_sync": ".ax/batch-sync.json",
                "status": ".ax/status.json",
                "batch_decision": "ready_for_batch_review",
                "batch_eval_decision": "needs_batch_review",
                "batch_sync_decision": "needs_batch_review",
                "status_decision": "needs_human_review",
                "artifact_consistency_decision": "consistent",
            },
        )

        self.assertTrue(stage["ready"])
        self.assertEqual(stage["details"]["batch"], ".ax/batch.md")
        self.assertEqual(stage["details"]["batch_eval_decision"], "needs_batch_review")
        self.assertEqual(stage["details"]["artifact_consistency_decision"], "consistent")

    def test_build_status_reports_next_actions(self) -> None:
        reports = {
            "blind_labels": {"decision": "needs_blind_label_review", "pending": 40, "failures": ["review still has pending blind labels"]},
            "suggestions": {"decision": "ready_for_human_acceptance"},
            "review_packet": {"decision": "ready_for_consolidated_review"},
            "review_workspace": {"decision": "needs_human_review"},
            "review_batch": {"decision": "ready_for_batch_review"},
            "review_batch_eval": {"decision": "missing"},
            "review_batch_sync": {"decision": "missing"},
            "post_review_runner": {"decision": "needs_human_review"},
            "hard_negative_review": {"decision": "needs_human_acceptance", "pending": 20, "failures": ["hard-negative review still has pending candidates"]},
        }

        status = module.build_status(reports)

        self.assertEqual(status["decision"], "needs_human_review")
        self.assertIn("review focused batch", status["next_actions"])
        self.assertIn("edit E63 consolidated review workspace", status["next_actions"])
        self.assertIn("dry-run classifiers:blind-review-workspace -- --mode=sync --dry-run before sync", status["next_actions"])
        self.assertIn("rerun classifiers:blind-post-review -- --sync-workspace after E63 edits", status["next_actions"])
        self.assertIn("label E49 blind review rows", status["next_actions"])
        self.assertIn("review E54 hard-negative candidates", status["next_actions"])

    def test_build_status_prefers_batch_eval_next_actions_when_incomplete(self) -> None:
        reports = {
            "blind_labels": {"decision": "needs_blind_label_review", "pending": 40, "failures": ["review still has pending blind labels"]},
            "review_workspace": {"decision": "needs_human_review"},
            "review_batch": {"decision": "ready_for_batch_review"},
            "review_batch_eval": {"decision": "needs_batch_review"},
            "review_batch_sync": {"decision": "missing"},
            "post_review_runner": {"decision": "needs_human_review"},
            "hard_negative_review": {"decision": "needs_human_acceptance", "pending": 20, "failures": ["hard-negative review still has pending candidates"]},
        }

        status = module.build_status(reports)

        self.assertIn("complete focused batch review fields", status["next_actions"])
        self.assertNotIn("review focused batch", status["next_actions"])

    def test_build_status_prefers_batch_sync_action_when_batch_eval_is_ready(self) -> None:
        reports = {
            "blind_labels": {"decision": "needs_blind_label_review", "pending": 40, "failures": ["review still has pending blind labels"]},
            "review_workspace": {"decision": "needs_human_review"},
            "review_batch": {"decision": "ready_for_batch_review"},
            "review_batch_eval": {"decision": "ready_for_batch_sync"},
            "review_batch_sync": {"decision": "missing"},
            "post_review_runner": {"decision": "needs_human_review"},
            "hard_negative_review": {"decision": "needs_human_acceptance", "pending": 20, "failures": ["hard-negative review still has pending candidates"]},
        }

        status = module.build_status(reports)

        self.assertIn("sync reviewed focused batch into E63", status["next_actions"])
        self.assertNotIn("complete focused batch review fields", status["next_actions"])

    def test_build_status_prefers_batch_sync_next_actions_when_ready(self) -> None:
        reports = {
            "blind_labels": {"decision": "needs_blind_label_review", "pending": 40, "failures": ["review still has pending blind labels"]},
            "review_workspace": {"decision": "needs_human_review"},
            "review_batch": {"decision": "ready_for_batch_review"},
            "review_batch_eval": {"decision": "ready_for_batch_sync"},
            "review_batch_sync": {
                "decision": "ready_for_workspace_dry_run",
                "batch_sha256": "abc123",
                "workspace_out": ".ax/experiments/blind-review-workspace-e79-merged-preview.md",
            },
            "post_review_runner": {"decision": "needs_human_review"},
            "hard_negative_review": {"decision": "needs_human_acceptance", "pending": 20, "failures": ["hard-negative review still has pending candidates"]},
        }

        status = module.build_status(reports)

        self.assertIn("inspect merged preview or sync reviewed batch into E63", status["next_actions"])
        self.assertIn("dry-run classifiers:blind-review-workspace -- --mode=sync --dry-run after batch sync", status["next_actions"])
        self.assertNotIn("review focused batch", status["next_actions"])
        self.assertEqual(status["artifact_consistency"]["decision"], "consistent")

    def test_build_status_prefers_incomplete_batch_eval_over_stale_sync(self) -> None:
        reports = {
            "blind_labels": {"decision": "needs_blind_label_review", "pending": 40, "failures": ["review still has pending blind labels"]},
            "review_workspace": {"decision": "needs_human_review"},
            "review_batch": {"decision": "ready_for_batch_review"},
            "review_batch_eval": {"decision": "needs_batch_review"},
            "review_batch_sync": {
                "decision": "ready_for_workspace_dry_run",
                "workspace_out": ".ax/experiments/blind-review-workspace-e79-merged-preview.md",
            },
            "post_review_runner": {"decision": "needs_human_review"},
            "hard_negative_review": {"decision": "needs_human_acceptance", "pending": 20, "failures": ["hard-negative review still has pending candidates"]},
        }

        status = module.build_status(reports)

        self.assertIn("complete focused batch review fields", status["next_actions"])
        self.assertNotIn("inspect merged preview or sync reviewed batch into E63", status["next_actions"])

    def test_build_status_reports_batch_eval_sync_hash_mismatch(self) -> None:
        reports = {
            "review_batch_eval": {"decision": "ready_for_batch_sync", "batch_sha256": "new"},
            "review_batch_sync": {"decision": "ready_for_workspace_dry_run", "batch_sha256": "old"},
        }

        status = module.build_status(reports)

        self.assertEqual(status["decision"], "needs_artifact_refresh")
        self.assertEqual(status["artifact_consistency"]["decision"], "stale_artifacts")
        self.assertEqual(
            status["artifact_consistency"]["failures"],
            ["review_batch_eval and review_batch_sync were generated from different batch contents"],
        )
        self.assertEqual(status["next_actions"], ["regenerate focused batch eval and sync reports from the same batch file"])

    def test_build_status_ready_when_reviews_are_done(self) -> None:
        reports = {
            "blind_labels": {"decision": "ready_for_blind_gate_eval", "pending": 0, "failures": []},
            "hard_negative_review": {"decision": "ready_for_hard_negative_export", "pending": 0, "failures": []},
        }

        status = module.build_status(reports)

        self.assertEqual(status["decision"], "ready_for_eval_and_export")

    def test_build_status_includes_candidate_gate_summary(self) -> None:
        reports = {
            "strict_none_gate": {
                "decision": "candidate_strict_none_gate",
                "blind_eval": False,
                "unsafe_none_miss_delta": {
                    "high_risk_environment_to_none": -16,
                },
            }
        }

        status = module.build_status(reports)

        self.assertEqual(status["candidate_gate_status"]["strict_none_gate"]["decision"], "candidate_strict_none_gate")
        self.assertFalse(status["candidate_gate_status"]["strict_none_gate"]["blind_eval"])
        self.assertEqual(status["candidate_gate_status"]["strict_none_gate"]["unsafe_none_miss_delta"]["high_risk_environment_to_none"], -16)


if __name__ == "__main__":
    unittest.main()
