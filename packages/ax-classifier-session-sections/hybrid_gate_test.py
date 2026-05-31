import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("hybrid_gate.py")
spec = importlib.util.spec_from_file_location("session_section_hybrid_gate", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_hybrid_gate"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class HybridGateTest(unittest.TestCase):
    def test_should_run_setfit_for_unlabeled_or_low_confidence_only(self) -> None:
        self.assertEqual(module.should_run_setfit({"light_results": []}, 0.75), (False, "unlabeled_without_causal_evidence"))
        self.assertEqual(
            module.should_run_setfit({
                "light_results": [],
                "approx_tokens": 200,
                "evidence": [
                    {"kind": "previous_assistant"},
                    {"kind": "recent_tool_failure"},
                ],
            }, 0.75),
            (True, "unlabeled"),
        )
        self.assertEqual(
            module.should_run_setfit({
                "light_results": [],
                "approx_tokens": 80,
                "evidence": [
                    {"kind": "previous_assistant"},
                    {"kind": "recent_tool_failure"},
                ],
            }, 0.75),
            (False, "unlabeled_not_context_rich"),
        )
        self.assertEqual(
            module.should_run_setfit({"light_results": [{"label": "direction", "confidence": 0.5}]}, 0.75),
            (True, "low_confidence_deterministic"),
        )
        self.assertEqual(
            module.should_run_setfit({"light_results": [{"label": "direction", "confidence": 0.9}]}, 0.75),
            (False, "deterministic_high_confidence"),
        )

    def test_build_report_tracks_model_only_evidence_and_disagreements(self) -> None:
        windows = [
            {"id": "a", "light_results": [], "evidence": [{"kind": "previous_assistant", "ref": "turn:1"}]},
            {"id": "b", "light_results": [{"label": "direction", "confidence": 0.5}], "evidence": []},
            {"id": "c", "light_results": [{"label": "correction", "confidence": 0.5}], "evidence": []},
        ]
        report = module.build_report(
            windows=windows,
            predictions_by_id={
                "a": {"label": "environment_or_preference_signal", "confidence": 0.8},
                "b": {"label": "environment_or_preference_signal", "confidence": 0.8},
                "c": {"label": "environment_or_preference_signal", "confidence": 0.8},
            },
            run_reasons={"a": "unlabeled", "b": "low_confidence_deterministic", "c": "low_confidence_deterministic"},
            elapsed_seconds=0.1,
            model_confidence=0.6,
        )

        self.assertEqual(report["model_only_positive_count"], 1)
        self.assertEqual(report["model_only_evidence_coverage"], 1.0)
        self.assertEqual(report["model_only_candidates"][0]["id"], "a")
        self.assertEqual(report["model_only_candidates"][0]["turn"], None)
        self.assertEqual(report["model_only_candidates"][0]["evidence"], [{"kind": "previous_assistant", "ref": "turn:1"}])
        self.assertEqual(report["disagreement_count"], 1)

    def test_positive_model_label_requires_non_none_and_threshold(self) -> None:
        self.assertTrue(module.positive_model_label("approval", 0.7, 0.6))
        self.assertFalse(module.positive_model_label("approval", 0.5, 0.6))
        self.assertFalse(module.positive_model_label("none", 0.9, 0.6))


if __name__ == "__main__":
    unittest.main()
