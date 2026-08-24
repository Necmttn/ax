#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_sensitivity.py")
spec = importlib.util.spec_from_file_location("session_section_blind_sensitivity", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_sensitivity"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindSensitivityTest(unittest.TestCase):
    def test_scenario_label_accepts_suggestion_baseline(self) -> None:
        suggestion = {"suggested_label": "environment_or_preference_signal"}
        priority = {"risk_reasons": ["environment_overprediction_risk"]}

        self.assertEqual(
            module.scenario_label("accept_suggestions", suggestion, priority),
            "environment_or_preference_signal",
        )

    def test_scenario_label_turns_high_risk_environment_to_none(self) -> None:
        suggestion = {"suggested_label": "environment_or_preference_signal"}
        priority = {"risk_reasons": ["environment_overprediction_risk"]}

        self.assertEqual(
            module.scenario_label("high_risk_environment_to_none", suggestion, priority),
            "none",
        )

    def test_scenario_label_conservative_none_for_any_review_risk(self) -> None:
        suggestion = {"suggested_label": "verification_or_recovery_signal"}
        priority = {"risk_reasons": ["low_confidence"]}

        self.assertEqual(
            module.scenario_label("conservative_risk_to_none", suggestion, priority),
            "none",
        )

    def test_synthetic_rows_keep_pending_review_separate(self) -> None:
        review = {"items": [{"id": "a", "text": "USER:\nstatus", "label": "__pending__", "target": "__pending__"}]}
        suggestions = {"items": [{"id": "a", "suggested_label": "none", "suggested_target": "context_recall"}]}
        priorities = {"items": [{"id": "a", "risk_reasons": ["possible_none_control_turn"]}]}

        rows = module.synthetic_rows(review, suggestions, priorities, "accept_suggestions")

        self.assertEqual(rows[0]["label"], "none")
        self.assertEqual(rows[0]["target"], "context_recall")
        self.assertEqual(rows[0]["synthetic_label_source"], "accept_suggestions")

    def test_build_report_marks_scenarios_as_not_blind_metrics(self) -> None:
        scenario_reports = [{"scenario": "accept_suggestions", "decision": "candidate_blind_gate_stack"}]

        report = module.build_report(scenario_reports)

        self.assertFalse(report["blind_eval"])
        self.assertEqual(report["decision"], "ready_for_human_label_comparison")


if __name__ == "__main__":
    unittest.main()
