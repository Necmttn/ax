#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_hard_negative_miner.py")
spec = importlib.util.spec_from_file_location("session_section_blind_hard_negative_miner", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_hard_negative_miner"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindHardNegativeMinerTest(unittest.TestCase):
    def test_is_candidate_requires_environment_prediction_and_risk_reason(self) -> None:
        priority = {
            "suggested_label": "environment_or_preference_signal",
            "risk_reasons": ["environment_overprediction_risk"],
            "priority_score": 3,
        }

        self.assertTrue(module.is_candidate(priority, min_score=3))

    def test_is_candidate_rejects_non_environment_suggestions(self) -> None:
        priority = {
            "suggested_label": "verification_or_recovery_signal",
            "risk_reasons": ["low_confidence"],
            "priority_score": 5,
        }

        self.assertFalse(module.is_candidate(priority, min_score=3))

    def test_candidate_row_is_not_training_ready(self) -> None:
        review_item = {
            "id": "blind/a",
            "text": "USER:\nwhat's next?",
            "source_window_id": "event_window:a",
        }
        priority = {
            "id": "blind/a",
            "priority_score": 7,
            "risk_reasons": ["possible_none_control_turn", "environment_overprediction_risk"],
            "suggested_label": "environment_or_preference_signal",
            "suggested_target": "workflow_state",
        }

        row = module.candidate_row(review_item, priority)

        self.assertEqual(row["proposed_label"], "none")
        self.assertEqual(row["status"], "pending_human_acceptance")
        self.assertEqual(row["original_suggested_label"], "environment_or_preference_signal")
        self.assertIn("blind/a", row["id"])

    def test_build_report_counts_candidates_and_risk_reasons(self) -> None:
        rows = [
            {"risk_reasons": ["environment_overprediction_risk", "context_dump"]},
            {"risk_reasons": ["environment_overprediction_risk"]},
        ]

        report = module.build_report(rows, priorities=4, min_score=3)

        self.assertEqual(report["candidates"], 2)
        self.assertEqual(report["risk_reason_counts"], {
            "context_dump": 1,
            "environment_overprediction_risk": 2,
        })
        self.assertEqual(report["decision"], "ready_for_human_acceptance")


if __name__ == "__main__":
    unittest.main()
