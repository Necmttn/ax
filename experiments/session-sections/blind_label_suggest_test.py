#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_label_suggest.py")
spec = importlib.util.spec_from_file_location("session_section_blind_label_suggest", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_label_suggest"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindLabelSuggestTest(unittest.TestCase):
    def test_target_hint_prefers_dev_environment_for_uv_text(self) -> None:
        item = {"text": "USER:\ncan you use uv for the python package issue"}

        self.assertEqual(module.target_hint(item, "environment_or_preference_signal"), "dev_environment")

    def test_target_hint_prefers_benchmark_required_for_results_text(self) -> None:
        item = {"text": "USER:\nrun the benchmark and tell me the results"}

        self.assertEqual(module.target_hint(item, "verification_or_recovery_signal"), "benchmark_required")

    def test_suggestion_records_prediction_without_accepting_label(self) -> None:
        item = {
            "id": "blind/a",
            "text": "USER:\ncan you use uv",
            "label": "__pending__",
            "target": "__pending__",
        }
        prediction = {
            "id": "blind/a",
            "predicted": "environment_or_preference_signal",
            "binary_confidence": 0.91,
            "family_confidence": 0.73,
        }

        suggestion = module.suggestion_for_item(item, prediction)

        self.assertEqual(suggestion["id"], "blind/a")
        self.assertEqual(suggestion["suggested_label"], "environment_or_preference_signal")
        self.assertEqual(suggestion["suggested_target"], "dev_environment")
        self.assertEqual(suggestion["current_label"], "__pending__")
        self.assertIn("model predicted", suggestion["rationale"])

    def test_build_report_counts_suggestions_and_keeps_review_pending(self) -> None:
        suggestions = [
            {"suggested_label": "none", "confidence_bucket": "high"},
            {"suggested_label": "none", "confidence_bucket": "medium"},
            {"suggested_label": "verification_or_recovery_signal", "confidence_bucket": "high"},
        ]

        report = module.build_report(suggestions, review_items=3, predictions=3)

        self.assertEqual(report["suggested_label_counts"], {"none": 2, "verification_or_recovery_signal": 1})
        self.assertEqual(report["confidence_buckets"], {"high": 2, "medium": 1})
        self.assertEqual(report["decision"], "ready_for_human_acceptance")


if __name__ == "__main__":
    unittest.main()
