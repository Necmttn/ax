import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("two_stage_calibration.py")
spec = importlib.util.spec_from_file_location("session_section_two_stage_calibration", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_two_stage_calibration"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class TwoStageCalibrationTest(unittest.TestCase):
    def test_calibrated_binary_predictions_turn_low_confidence_actionable_to_none(self) -> None:
        predictions = [
            {"id": "n1", "actual": "none", "predicted": "actionable", "confidence": 0.61},
            {"id": "a1", "actual": "actionable", "predicted": "actionable", "confidence": 0.91},
            {"id": "n2", "actual": "none", "predicted": "none", "confidence": 0.70},
        ]

        calibrated = module.calibrated_binary_predictions(predictions, 0.80)

        self.assertEqual(calibrated, ["none", "actionable", "none"])

    def test_final_predictions_after_binary_calibration_reuses_original_families(self) -> None:
        final_examples = [
            {"id": "n1", "actual": "none", "predicted": "approval"},
            {"id": "a1", "actual": "approval", "predicted": "approval"},
            {"id": "n2", "actual": "none", "predicted": "none"},
        ]
        binary_predictions = ["none", "actionable", "none"]

        final = module.final_predictions_after_binary_calibration(final_examples, binary_predictions)

        self.assertEqual(final, ["none", "approval", "none"])

    def test_threshold_metrics_reports_none_false_positive_rate(self) -> None:
        run = {
            "examples": [
                {"id": "n1", "actual": "none", "predicted": "approval"},
                {"id": "a1", "actual": "approval", "predicted": "approval"},
                {"id": "n2", "actual": "none", "predicted": "none"},
            ],
            "binary": {
                "predictions_with_confidence": [
                    {"id": "n1", "actual": "none", "predicted": "actionable", "confidence": 0.61},
                    {"id": "a1", "actual": "actionable", "predicted": "actionable", "confidence": 0.91},
                    {"id": "n2", "actual": "none", "predicted": "none", "confidence": 0.70},
                ],
            },
        }

        metrics = module.threshold_metrics(run, 0.80)

        self.assertEqual(metrics["threshold"], 0.8)
        self.assertEqual(metrics["none_false_positive_rate"], 0.0)
        self.assertEqual(metrics["prediction_counts"], {"approval": 1, "none": 2})


if __name__ == "__main__":
    unittest.main()
