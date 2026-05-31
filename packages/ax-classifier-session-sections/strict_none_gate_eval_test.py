#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("strict_none_gate_eval.py")
spec = importlib.util.spec_from_file_location("session_section_strict_none_gate_eval", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_strict_none_gate_eval"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class StrictNoneGateEvalTest(unittest.TestCase):
    def test_eval_scenario_applies_strict_overrides(self) -> None:
        rows = [
            {"id": "a", "label": "none", "text": "USER:\n# AGENTS.md instructions <INSTRUCTIONS>"},
            {"id": "b", "label": "environment_or_preference_signal", "text": "USER:\nuse docker compose for db"},
        ]
        predictions = [
            {"id": "a", "predicted": "environment_or_preference_signal"},
            {"id": "b", "predicted": "environment_or_preference_signal"},
        ]

        report = module.eval_scenario("test", rows, predictions)

        self.assertEqual(report["scenario"], "test")
        self.assertEqual(report["strict_none_override_count"], 1)
        self.assertEqual(report["unsafe_none_miss_count"], 0)
        self.assertEqual(report["metrics"]["accuracy"], 1.0)

    def test_build_report_marks_candidate_when_unsafe_misses_improve(self) -> None:
        reports = [
            {"scenario": "high_risk_environment_to_none", "unsafe_none_miss_count": 4},
            {"scenario": "conservative_risk_to_none", "unsafe_none_miss_count": 7},
        ]

        report = module.build_report(reports, baseline_unsafe={"high_risk_environment_to_none": 20, "conservative_risk_to_none": 26})

        self.assertEqual(report["unsafe_none_miss_delta"]["high_risk_environment_to_none"], -16)
        self.assertEqual(report["decision"], "candidate_strict_none_gate")


if __name__ == "__main__":
    unittest.main()
