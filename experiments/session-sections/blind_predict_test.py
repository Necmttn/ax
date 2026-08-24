import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_predict.py")
spec = importlib.util.spec_from_file_location("session_section_blind_predict", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_predict"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindPredictTest(unittest.TestCase):
    def test_family_test_rows_follow_actionable_binary_predictions(self) -> None:
        rows = [{"id": "n1"}, {"id": "a1"}, {"id": "v1"}]

        selected = module.family_test_rows(rows, ["none", "actionable", "actionable"])

        self.assertEqual(selected, [{"id": "a1"}, {"id": "v1"}])

    def test_prediction_records_include_binary_and_family_confidence(self) -> None:
        rows = [
            {"id": "n1", "source_window_id": "event_window:n1"},
            {"id": "a1", "source_window_id": "event_window:a1"},
        ]
        binary_details = [
            {"id": "n1", "predicted": "none", "confidence": 0.8},
            {"id": "a1", "predicted": "actionable", "confidence": 0.7},
        ]
        family_details = [
            {"id": "a1", "predicted": "approval", "confidence": 0.6},
        ]

        records = module.prediction_records(
            rows,
            final_predictions=["none", "approval"],
            binary_details=binary_details,
            family_details=family_details,
        )

        self.assertEqual(records, [
            {
                "id": "n1",
                "source_window_id": "event_window:n1",
                "predicted": "none",
                "binary_predicted": "none",
                "binary_confidence": 0.8,
                "family_predicted": None,
                "family_confidence": None,
            },
            {
                "id": "a1",
                "source_window_id": "event_window:a1",
                "predicted": "approval",
                "binary_predicted": "actionable",
                "binary_confidence": 0.7,
                "family_predicted": "approval",
                "family_confidence": 0.6,
            },
        ])

    def test_build_report_summarizes_prediction_counts(self) -> None:
        records = [
            {"id": "n1", "predicted": "none"},
            {"id": "a1", "predicted": "approval"},
            {"id": "v1", "predicted": "approval"},
        ]

        report = module.build_report(
            records,
            train_rows=10,
            blind_rows=3,
            model="test-model",
            label_mode="coarse",
            train_seconds=12.34,
            predict_seconds=0.56,
        )

        self.assertEqual(report["prediction_counts"], {"approval": 2, "none": 1})
        self.assertEqual(report["decision"], "ready_for_blind_eval_after_labeling")


if __name__ == "__main__":
    unittest.main()
