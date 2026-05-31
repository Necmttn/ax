#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_review_priority.py")
spec = importlib.util.spec_from_file_location("session_section_blind_review_priority", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_review_priority"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindReviewPriorityTest(unittest.TestCase):
    def test_risk_reasons_flag_low_confidence(self) -> None:
        suggestion = {"confidence_bucket": "low", "suggested_label": "verification_or_recovery_signal"}
        item = {"text": "USER:\nrun tests"}

        reasons = module.risk_reasons(item, suggestion)

        self.assertIn("low_confidence", reasons)

    def test_risk_reasons_flag_possible_none_control_turn(self) -> None:
        suggestion = {"confidence_bucket": "high", "suggested_label": "environment_or_preference_signal"}
        item = {"text": "USER:\nwhat's next?"}

        reasons = module.risk_reasons(item, suggestion)

        self.assertIn("possible_none_control_turn", reasons)
        self.assertIn("environment_overprediction_risk", reasons)

    def test_priority_score_orders_risky_environment_above_high_confidence_signal(self) -> None:
        risky = module.priority_item(
            {"id": "a", "text": "USER:\ncan I merge this?"},
            {"id": "a", "suggested_label": "environment_or_preference_signal", "confidence_bucket": "high"},
        )
        ordinary = module.priority_item(
            {"id": "b", "text": "USER:\nplease run the benchmark"},
            {"id": "b", "suggested_label": "verification_or_recovery_signal", "confidence_bucket": "high"},
        )

        self.assertGreater(risky["priority_score"], ordinary["priority_score"])

    def test_build_report_counts_risk_reasons(self) -> None:
        priorities = [
            {"risk_reasons": ["low_confidence", "environment_overprediction_risk"]},
            {"risk_reasons": ["environment_overprediction_risk"]},
        ]

        report = module.build_report(priorities, review_items=2, suggestions=2, limit=10)

        self.assertEqual(report["risk_reason_counts"], {
            "environment_overprediction_risk": 2,
            "low_confidence": 1,
        })
        self.assertEqual(report["top_priority_count"], 2)
        self.assertEqual(report["decision"], "ready_for_prioritized_review")


if __name__ == "__main__":
    unittest.main()
