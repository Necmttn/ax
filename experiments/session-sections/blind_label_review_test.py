#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_label_review.py")
spec = importlib.util.spec_from_file_location("session_section_blind_label_review", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_label_review"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindLabelReviewTest(unittest.TestCase):
    def test_generate_review_preserves_blind_rows_without_predictions(self) -> None:
        rows = [
            {
                "id": "blind/a",
                "source_window_id": "event_window:a",
                "label": "__pending__",
                "target": "__pending__",
                "text": "USER:\nUse uv",
                "approx_tokens": 12,
                "evidence": [{"ref": "turn:a"}],
            }
        ]

        review = module.generate_review(rows)

        self.assertEqual(review["schema"], "ax.blind_session_section_label_review.v1")
        self.assertEqual(review["items"][0]["id"], "blind/a")
        self.assertNotIn("predicted", review["items"][0])
        self.assertEqual(review["items"][0]["label"], "__pending__")

    def test_sync_review_updates_fixture_labels_and_notes(self) -> None:
        rows = [
            {
                "id": "blind/a",
                "label": "__pending__",
                "target": "__pending__",
                "review_notes": "",
                "text": "USER:\nUse uv",
            }
        ]
        review = module.generate_review(rows)
        brief = module.render_markdown_brief(review).replace(
            "- Label: `__pending__`\n- Target: `__pending__`\n- Review notes: _pending_",
            "- Label: `environment_or_preference_signal`\n- Target: `dev_environment`\n- Review notes: User states a durable tooling preference.",
        )

        synced_review = module.sync_review_from_markdown(review, brief)
        labeled = module.apply_review_to_fixtures(rows, synced_review)

        self.assertEqual(labeled[0]["label"], "environment_or_preference_signal")
        self.assertEqual(labeled[0]["target"], "dev_environment")
        self.assertEqual(labeled[0]["review_notes"], "User states a durable tooling preference.")

    def test_evaluate_review_reports_pending_and_invalid_labels(self) -> None:
        review = {
            "items": [
                {"id": "a", "label": "__pending__", "target": "__pending__", "review_notes": ""},
                {"id": "b", "label": "bad_label", "target": "none", "review_notes": "x"},
                {"id": "c", "label": "none", "target": "none", "review_notes": "ordinary control turn"},
            ]
        }

        report = module.evaluate_review(review)

        self.assertEqual(report["items"], 3)
        self.assertEqual(report["pending"], 1)
        self.assertEqual(report["invalid_labels"], ["b"])
        self.assertIn("review still has pending blind labels", report["failures"])
        self.assertIn("review contains invalid blind labels", report["failures"])
        self.assertEqual(report["decision"], "needs_blind_label_review")

    def test_evaluate_review_blocks_non_substantive_notes(self) -> None:
        review = {
            "items": [
                {"id": "a", "label": "none", "target": "none", "review_notes": "ok"},
            ]
        }

        report = module.evaluate_review(review)

        self.assertEqual(report["reviewed_labels_missing_notes"], [])
        self.assertEqual(report["reviewed_labels_invalid_notes"], ["a"])
        self.assertIn("reviewed blind labels have non-substantive review notes", report["failures"])
        self.assertEqual(report["decision"], "needs_blind_label_review")

    def test_evaluate_review_ready_when_all_labels_valid(self) -> None:
        review = {
            "items": [
                {"id": "a", "label": "none", "target": "none", "review_notes": "status request"},
                {
                    "id": "b",
                    "label": "verification_or_recovery_signal",
                    "target": "benchmark_required",
                    "review_notes": "user asks for proof",
                },
            ]
        }

        report = module.evaluate_review(review)

        self.assertEqual(report["pending"], 0)
        self.assertEqual(report["invalid_labels"], [])
        self.assertEqual(report["decision"], "ready_for_blind_gate_eval")


if __name__ == "__main__":
    unittest.main()
