#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import io
import tempfile
import sys
import unittest
from unittest import mock
from pathlib import Path

SCRIPT_PATH = Path(__file__).with_name("blind_review_workspace.py")
spec = importlib.util.spec_from_file_location("session_section_blind_review_workspace", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_review_workspace"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindReviewWorkspaceTest(unittest.TestCase):
    def test_render_workspace_includes_review_context_fields(self) -> None:
        packet = {
            "items": [{
                "id": "blind/a",
                "label": "__pending__",
                "target": "__pending__",
                "review_notes": "",
                "hard_negative_candidate_id": "pending-hard-negative/blind/a",
                "hard_negative_status": "pending_human_acceptance",
                "hard_negative_proposed_label": "none",
                "hard_negative_proposed_target": "none",
                "hard_negative_review_instruction": "Accept if this is ordinary control flow.",
                "suggested_label": "environment_or_preference_signal",
                "suggested_target": "workflow_state",
                "confidence_bucket": "medium",
                "binary_confidence": 0.9,
                "family_confidence": 0.7,
                "priority_score": 9,
                "risk_reasons": ["possible_none_control_turn"],
                "source_window_id": "event_window:a",
                "source_turn": "turn:a",
                "source_session": "session:a",
                "source_seq": 1,
                "approx_tokens": 10,
                "evidence_refs": ["turn:a"],
                "text": "USER:\nwhat next?",
            }],
        }

        markdown = module.render_workspace(packet)

        self.assertIn("- Hard-negative proposed label/target: `none` / `none`", markdown)
        self.assertIn("- Hard-negative review instruction: Accept if this is ordinary control flow.", markdown)
        self.assertIn("- Confidence bucket: `medium`", markdown)
        self.assertIn("- Evidence: `turn:a`", markdown)

    def test_parse_workspace_extracts_review_and_hard_negative_updates(self) -> None:
        markdown = """
## 1. blind/a

- Review label: `none`
- Review target: `none`
- Review notes: ordinary workflow control
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `accepted`
- Hard-negative notes: useful none boundary
"""

        updates = module.parse_workspace(markdown)

        self.assertEqual(updates["blind/a"]["label"], "none")
        self.assertEqual(updates["blind/a"]["target"], "none")
        self.assertEqual(updates["blind/a"]["review_notes"], "ordinary workflow control")
        self.assertEqual(updates["blind/a"]["hard_negative_candidate_id"], "pending-hard-negative/blind/a")
        self.assertEqual(updates["blind/a"]["hard_negative_status"], "accepted")
        self.assertEqual(updates["blind/a"]["hard_negative_review_notes"], "useful none boundary")

    def test_sync_review_updates_authoritative_review_items(self) -> None:
        review = {"items": [{"id": "blind/a", "label": "__pending__", "target": "__pending__", "review_notes": ""}]}
        updates = {"blind/a": {"label": "none", "target": "none", "review_notes": "control turn"}}

        synced = module.sync_review(review, updates)

        self.assertEqual(synced["items"][0]["label"], "none")
        self.assertEqual(synced["items"][0]["target"], "none")
        self.assertEqual(synced["items"][0]["review_notes"], "control turn")

    def test_sync_hard_negatives_updates_by_candidate_id(self) -> None:
        candidates = {
            "items": [
                {
                    "id": "pending-hard-negative/blind/a",
                    "status": "pending_human_acceptance",
                    "review_notes": "",
                }
            ]
        }
        updates = {
            "blind/a": {
                "hard_negative_candidate_id": "pending-hard-negative/blind/a",
                "hard_negative_status": "accepted",
                "hard_negative_review_notes": "good boundary",
            }
        }

        synced = module.sync_hard_negatives(candidates, updates)

        self.assertEqual(synced["items"][0]["status"], "accepted")
        self.assertEqual(synced["items"][0]["review_notes"], "good boundary")

    def test_build_report_blocks_until_both_reviews_ready(self) -> None:
        report = module.build_report(
            {"decision": "ready_for_blind_gate_eval", "pending": 0},
            {"decision": "needs_human_acceptance", "pending": 1, "accepted": 0},
        )

        self.assertEqual(report["decision"], "needs_human_review")
        self.assertIn("hard-negative review is not ready", report["failures"])

    def test_validate_workspace_updates_rejects_invalid_label_status_and_candidate(self) -> None:
        review = {"items": [{"id": "blind/a"}]}
        candidates = {"items": [{"id": "pending-hard-negative/blind/a"}]}
        updates = {
            "blind/a": {
                "label": "surprise",
                "target": "mystery",
                "hard_negative_candidate_id": "missing-candidate",
                "hard_negative_status": "maybe",
            },
            "blind/missing": {
                "label": "none",
                "target": "none",
            },
        }

        failures = module.validate_workspace_updates(updates, review, candidates)

        self.assertIn("invalid review label for blind/a: surprise", failures)
        self.assertIn("invalid review target for blind/a: mystery", failures)
        self.assertIn("unknown hard-negative candidate id for blind/a: missing-candidate", failures)
        self.assertIn("invalid hard-negative status for blind/a: maybe", failures)
        self.assertIn("workspace row does not match review item: blind/missing", failures)

    def test_validate_workspace_updates_rejects_non_substantive_notes_before_write(self) -> None:
        review = {"items": [{"id": "blind/a"}]}
        candidates = {"items": [{"id": "pending-hard-negative/blind/a"}]}
        updates = {
            "blind/a": {
                "label": "none",
                "target": "none",
                "review_notes": "ok",
                "hard_negative_candidate_id": "pending-hard-negative/blind/a",
                "hard_negative_status": "accepted",
                "hard_negative_review_notes": "yep",
            },
        }

        failures = module.validate_workspace_updates(updates, review, candidates)

        self.assertIn("non-substantive review notes for blind/a", failures)
        self.assertIn("non-substantive hard-negative notes for blind/a: pending-hard-negative/blind/a", failures)

    def test_build_report_distinguishes_workspace_update_failures(self) -> None:
        report = module.build_report(
            {"decision": "needs_blind_label_review", "pending": 1},
            {"decision": "needs_human_acceptance", "pending": 1, "accepted": 0},
            ["invalid review label for blind/a: surprise"],
        )

        self.assertEqual(report["decision"], "needs_workspace_fix")
        self.assertEqual(report["workspace_update_failures"], ["invalid review label for blind/a: surprise"])

    def test_workspace_progress_reports_counts_and_next_pending_ids(self) -> None:
        review = {
            "items": [
                {"id": "blind/a", "label": "none", "target": "none"},
                {"id": "blind/b", "label": "__pending__", "target": "__pending__"},
            ]
        }
        candidates = {
            "items": [
                {"id": "candidate/a", "status": "accepted"},
                {"id": "candidate/b", "status": "pending_human_acceptance"},
            ]
        }

        progress = module.workspace_progress(review, candidates)

        self.assertEqual(progress["blind_label_reviewed"], 1)
        self.assertEqual(progress["blind_label_pending"], 1)
        self.assertEqual(progress["blind_label_next_pending_ids"], ["blind/b"])
        self.assertEqual(progress["blind_label_next_pending_refs"], [{"ordinal": 2, "id": "blind/b"}])
        self.assertEqual(progress["hard_negative_reviewed"], 1)
        self.assertEqual(progress["hard_negative_pending"], 1)
        self.assertEqual(progress["hard_negative_next_pending_ids"], ["candidate/b"])
        self.assertEqual(
            progress["hard_negative_next_pending_refs"],
            [{"ordinal": 2, "id": "candidate/b", "source_blind_id": ""}],
        )

    def test_dry_run_sync_does_not_write_authoritative_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            review_path = root / "review.json"
            candidates_path = root / "candidates.json"
            workspace_path = root / "workspace.md"
            label_report_path = root / "label-report.json"
            hard_report_path = root / "hard-report.json"
            out_path = root / "workspace-report.json"
            review_path.write_text(
                '{"items":[{"id":"blind/a","label":"__pending__","target":"__pending__","review_notes":""}]}'
            )
            candidates_path.write_text(
                '{"items":[{"id":"pending-hard-negative/blind/a","status":"pending_human_acceptance","review_notes":""}]}'
            )
            workspace_path.write_text(
                """
## 1. blind/a

- Review label: `none`
- Review target: `none`
- Review notes: control turn
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `accepted`
- Hard-negative notes: good boundary
"""
            )
            args = [
                "--mode=sync",
                "--dry-run",
                f"--workspace={workspace_path}",
                f"--review={review_path}",
                f"--hard-negatives={candidates_path}",
                f"--label-report={label_report_path}",
                f"--hard-negative-report={hard_report_path}",
                f"--out={out_path}",
            ]

            with mock.patch.object(sys, "argv", ["blind_review_workspace.py", *args]), mock.patch("sys.stdout", io.StringIO()):
                exit_code = module.main()

            self.assertEqual(exit_code, 0)
            self.assertIn('"label":"__pending__"', review_path.read_text())
            self.assertIn('"status":"pending_human_acceptance"', candidates_path.read_text())
            self.assertFalse(label_report_path.exists())
            self.assertFalse(hard_report_path.exists())
            self.assertIn('"dry_run": true', out_path.read_text())


if __name__ == "__main__":
    unittest.main()
