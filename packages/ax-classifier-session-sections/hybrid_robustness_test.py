import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("hybrid_robustness.py")
spec = importlib.util.spec_from_file_location("session_section_hybrid_robustness", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_hybrid_robustness"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class HybridRobustnessTest(unittest.TestCase):
    def test_build_report_passes_when_gate_fixes_none_false_positives(self) -> None:
        report = {
            "schema": "ax.setfit_robustness_report.v1",
            "model": "test-model",
            "decision": "needs_model_quality_work",
            "failures": ["worst none false-positive rate is not below 10%"],
            "runs": [
                {
                    "seed": 7,
                    "calibrated": {
                        "examples": [
                            {"id": "none-continue", "actual": "none", "predicted": "verification_or_recovery_signal"},
                            {"id": "approval-ok", "actual": "approval", "predicted": "approval"},
                            {"id": "correction-ok", "actual": "correction_or_rejection_signal", "predicted": "correction_or_rejection_signal"},
                            {"id": "environment-ok", "actual": "environment_or_preference_signal", "predicted": "environment_or_preference_signal"},
                            {"id": "verification-ok", "actual": "verification_or_recovery_signal", "predicted": "verification_or_recovery_signal"},
                        ],
                    },
                }
            ],
        }
        fixtures = {
            "none-continue": {
                "id": "none-continue",
                "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was already executing the agreed plan.",
            },
            "approval-ok": {"id": "approval-ok", "text": "USER:\nyes continue"},
            "correction-ok": {"id": "correction-ok", "text": "USER:\nthat is wrong"},
            "environment-ok": {"id": "environment-ok", "text": "USER:\nuse uv"},
            "verification-ok": {"id": "verification-ok", "text": "USER:\nrun the tests"},
        }

        result = module.build_report(report, fixtures)

        self.assertEqual(result["schema"], "ax.setfit_hybrid_robustness_report.v1")
        self.assertEqual(result["decision"], "hybrid_robust_enough")
        self.assertEqual(result["failures"], [])
        self.assertEqual(result["baseline_summary"]["none_false_positive_rate_max"], 1.0)
        self.assertEqual(result["summary"]["none_false_positive_rate_max"], 0.0)
        self.assertEqual(result["fixed_none_false_positive_count_total"], 1)
        self.assertEqual(result["harmful_override_count_total"], 0)

    def test_build_report_rejects_harmful_overrides_even_when_metrics_pass(self) -> None:
        report = {
            "runs": [
                {
                    "seed": 7,
                    "examples": [
                        {"id": "signal", "actual": "verification_or_recovery_signal", "predicted": "verification_or_recovery_signal"},
                    ],
                }
            ],
        }
        fixtures = {
            "signal": {
                "id": "signal",
                "text": "USER:\nwhat was the task i gave you?\n\nPREVIOUS_ASSISTANT:\nThe user wants context recall.",
            },
        }

        result = module.build_report(report, fixtures)

        self.assertEqual(result["decision"], "reject_hybrid_robustness")
        self.assertEqual(result["harmful_override_count_total"], 1)

    def test_build_report_keeps_quality_failures_when_gate_is_insufficient(self) -> None:
        report = {
            "runs": [
                {
                    "seed": 7,
                    "examples": [
                        {"id": "none-a", "actual": "none", "predicted": "approval"},
                        {"id": "approval-a", "actual": "approval", "predicted": "verification_or_recovery_signal"},
                    ],
                }
            ],
        }
        fixtures = {
            "none-a": {"id": "none-a", "text": "USER:\nordinary question"},
            "approval-a": {"id": "approval-a", "text": "USER:\nyes go"},
        }

        result = module.build_report(report, fixtures)

        self.assertEqual(result["decision"], "needs_hybrid_quality_work")
        self.assertIn("mean macro F1 is below 0.75", result["failures"])


if __name__ == "__main__":
    unittest.main()
