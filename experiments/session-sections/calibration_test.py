import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("calibration.py")
spec = importlib.util.spec_from_file_location("session_section_calibration", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_calibration"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class CalibrationTest(unittest.TestCase):
    def test_calibrated_label_abstains_low_confidence_positive_to_none(self) -> None:
        self.assertEqual(module.calibrated_label("approval", 0.49, 0.5), "none")
        self.assertEqual(module.calibrated_label("approval", 0.5, 0.5), "approval")
        self.assertEqual(module.calibrated_label("none", 0.99, 0.5), "none")

    def test_threshold_metrics_computes_none_false_positive_rate(self) -> None:
        report = module.threshold_metrics([
            "none",
            "approval",
            "approval",
        ], [
            {"label": "approval", "confidence": 0.4},
            {"label": "approval", "confidence": 0.8},
            {"label": "none", "confidence": 0.9},
        ], 0.5)

        self.assertEqual(report["none_false_positive_rate"], 0.0)
        self.assertEqual(report["prediction_counts"]["none"], 2)

    def test_sweep_thresholds_includes_expected_range(self) -> None:
        reports = module.sweep_thresholds(["none"], [{"label": "approval", "confidence": 0.4}])

        self.assertEqual(reports[0]["threshold"], 0.0)
        self.assertEqual(reports[-1]["threshold"], 0.95)


if __name__ == "__main__":
    unittest.main()
