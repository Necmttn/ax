#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("hard_negative_review.py")
spec = importlib.util.spec_from_file_location("session_section_hard_negative_review", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_hard_negative_review"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class HardNegativeReviewTest(unittest.TestCase):
    def test_parse_markdown_updates_status_and_notes_by_candidate_id(self) -> None:
        brief = """
## 1. blind/a

- Candidate id: `pending-hard-negative/blind/a`
- Status: `accepted`
- Review notes: ordinary status/control turn
"""

        updates = module.parse_markdown_review(brief)

        self.assertEqual(updates["pending-hard-negative/blind/a"]["status"], "accepted")
        self.assertEqual(updates["pending-hard-negative/blind/a"]["review_notes"], "ordinary status/control turn")

    def test_sync_candidates_from_markdown_updates_only_known_candidates(self) -> None:
        candidates = {
            "items": [
                {"id": "pending-hard-negative/blind/a", "status": "pending_human_acceptance", "review_notes": ""}
            ]
        }
        brief = """
## 1. blind/a

- Candidate id: `pending-hard-negative/blind/a`
- Status: `rejected`
- Review notes: actual durable preference
"""

        synced = module.sync_candidates_from_markdown(candidates, brief)

        self.assertEqual(synced["items"][0]["status"], "rejected")
        self.assertEqual(synced["items"][0]["review_notes"], "actual durable preference")

    def test_evaluate_candidates_requires_notes_for_accepted_or_rejected(self) -> None:
        candidates = {
            "items": [
                {"id": "a", "status": "accepted", "review_notes": ""},
                {"id": "b", "status": "rejected", "review_notes": "not none"},
                {"id": "c", "status": "pending_human_acceptance", "review_notes": ""},
            ]
        }

        report = module.evaluate_candidates(candidates)

        self.assertEqual(report["accepted"], 1)
        self.assertEqual(report["rejected"], 1)
        self.assertEqual(report["pending"], 1)
        self.assertEqual(report["reviewed_missing_notes"], ["a"])
        self.assertEqual(report["decision"], "needs_human_acceptance")

    def test_evaluate_candidates_blocks_non_substantive_notes(self) -> None:
        candidates = {
            "items": [
                {"id": "a", "status": "accepted", "review_notes": "ok"},
            ]
        }

        report = module.evaluate_candidates(candidates)

        self.assertEqual(report["reviewed_missing_notes"], [])
        self.assertEqual(report["reviewed_invalid_notes"], ["a"])
        self.assertIn("reviewed hard-negative candidates have non-substantive notes", report["failures"])
        self.assertEqual(report["decision"], "needs_human_acceptance")

    def test_evaluate_candidates_ready_when_all_reviewed_with_notes(self) -> None:
        candidates = {
            "items": [
                {"id": "a", "status": "accepted", "review_notes": "none control"},
                {"id": "b", "status": "rejected", "review_notes": "real preference"},
            ]
        }

        report = module.evaluate_candidates(candidates)

        self.assertEqual(report["pending"], 0)
        self.assertEqual(report["decision"], "ready_for_hard_negative_export")


if __name__ == "__main__":
    unittest.main()
