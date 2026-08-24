#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_eval_roundtrip.py")
spec = importlib.util.spec_from_file_location("session_section_blind_eval_roundtrip", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_eval_roundtrip"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindEvalRoundTripTest(unittest.TestCase):
    def test_build_pending_report_does_not_claim_eval_metrics(self) -> None:
        label_report = {
            "decision": "needs_blind_label_review",
            "items": 40,
            "pending": 7,
            "failures": ["review still has pending blind labels"],
        }

        report = module.build_pending_report(label_report, "fixtures.jsonl", "predictions.jsonl")

        self.assertEqual(report["schema"], "ax.blind_eval_roundtrip.v1")
        self.assertEqual(report["label_review_decision"], "needs_blind_label_review")
        self.assertEqual(report["pending_labels"], 7)
        self.assertNotIn("blind_gate_metrics", report)
        self.assertEqual(report["decision"], "needs_blind_label_review")

    def test_build_ready_report_embeds_gate_metrics(self) -> None:
        label_report = {
            "decision": "ready_for_blind_gate_eval",
            "items": 2,
            "pending": 0,
            "failures": [],
        }
        gate_report = {
            "decision": "candidate_blind_gate_stack",
            "metrics": {"macro_f1": 0.91, "accuracy": 0.95, "none_false_positive_rate": 0.0},
            "unsafe_none_miss_count": 0,
            "remaining_miss_count": 1,
        }

        report = module.build_ready_report(label_report, gate_report, "fixtures.jsonl", "predictions.jsonl", "eval.json")

        self.assertEqual(report["label_review_decision"], "ready_for_blind_gate_eval")
        self.assertEqual(report["blind_gate_decision"], "candidate_blind_gate_stack")
        self.assertEqual(report["blind_gate_metrics"]["macro_f1"], 0.91)
        self.assertEqual(report["unsafe_none_miss_count"], 0)
        self.assertEqual(report["decision"], "candidate_blind_gate_stack")

    def test_roundtrip_report_uses_gate_failure_decision_when_eval_runs_but_fails(self) -> None:
        label_report = {"decision": "ready_for_blind_gate_eval", "items": 2, "pending": 0, "failures": []}
        gate_report = {
            "decision": "needs_gate_stack_work",
            "metrics": {"macro_f1": 0.61, "accuracy": 0.5, "none_false_positive_rate": 0.25},
            "unsafe_none_miss_count": 1,
            "remaining_miss_count": 2,
        }

        report = module.build_ready_report(label_report, gate_report, "fixtures.jsonl", "predictions.jsonl", "eval.json")

        self.assertEqual(report["decision"], "needs_gate_stack_work")
        self.assertEqual(report["unsafe_none_miss_count"], 1)


if __name__ == "__main__":
    unittest.main()
