import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("robustness.py")
spec = importlib.util.spec_from_file_location("session_section_robustness", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_robustness"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class RobustnessTest(unittest.TestCase):
    def test_parse_seeds_requires_at_least_one_seed(self) -> None:
        self.assertEqual(module.parse_seeds("7, 13,42"), [7, 13, 42])
        with self.assertRaises(ValueError):
            module.parse_seeds("")

    def test_summarize_runs_reports_mean_min_max(self) -> None:
        summary = module.summarize_runs([
            {"macro_f1": 0.7, "accuracy": 0.8, "none_false_positive_rate": 0.0, "train_seconds": 10.0},
            {"macro_f1": 0.9, "accuracy": 0.6, "none_false_positive_rate": 0.2, "train_seconds": 12.0},
        ])

        self.assertEqual(summary["macro_f1_mean"], 0.8)
        self.assertEqual(summary["macro_f1_min"], 0.7)
        self.assertEqual(summary["macro_f1_max"], 0.9)
        self.assertEqual(summary["none_false_positive_rate_max"], 0.2)
        self.assertEqual(summary["train_seconds_total"], 22.0)

    def test_calibrated_label_abstains_low_confidence_positives(self) -> None:
        self.assertEqual(module.calibrated_label("approval", 0.39, 0.4), "none")
        self.assertEqual(module.calibrated_label("approval", 0.4, 0.4), "approval")
        self.assertEqual(module.calibrated_label("none", 0.2, 0.4), "none")
        self.assertEqual(module.calibrated_label("approval", 0.1, None), "approval")

    def test_calibrated_runs_extracts_only_calibrated_reports(self) -> None:
        runs = [
            {"seed": 1, "macro_f1": 0.5},
            {"seed": 2, "macro_f1": 0.5, "calibrated": {"macro_f1": 0.7}},
        ]

        self.assertEqual(module.calibrated_runs(runs), [{"macro_f1": 0.7}])

    def test_split_rows_uses_fixed_test_ids_when_provided(self) -> None:
        rows = [
            {"id": "case-a", "label": "none", "text": "USER:\na"},
            {"id": "case-b", "label": "direction", "text": "USER:\nb"},
            {"id": "case-c", "label": "approval", "text": "USER:\nc"},
        ]

        train, test = module.split_rows(rows, seed=42, test_ids={"case-b"}, group_field=None)

        self.assertEqual([row["id"] for row in train], ["case-a", "case-c"])
        self.assertEqual([row["id"] for row in test], ["case-b"])

    def test_split_rows_can_use_group_field(self) -> None:
        rows = [
            {"id": "a1", "label": "approval", "target": "continue", "text": "USER:\na1"},
            {"id": "a2", "label": "approval", "target": "start", "text": "USER:\na2"},
            {"id": "n1", "label": "none", "target": "question", "text": "USER:\nn1"},
            {"id": "n2", "label": "none", "target": "status", "text": "USER:\nn2"},
        ]

        train, test = module.split_rows(rows, seed=1, test_ids=None, group_field="target")

        self.assertFalse({row["target"] for row in train} & {row["target"] for row in test})

    def test_failure_reasons_enforce_robustness_gates(self) -> None:
        self.assertEqual(module.failure_reasons({
            "macro_f1_mean": 0.76,
            "macro_f1_min": 0.71,
            "none_false_positive_rate_max": 0.0,
        }), [])
        failures = module.failure_reasons({
            "macro_f1_mean": 0.74,
            "macro_f1_min": 0.69,
            "none_false_positive_rate_max": 0.1,
        })
        self.assertIn("mean macro F1 is below 0.75", failures)
        self.assertIn("minimum macro F1 is below 0.70", failures)
        self.assertIn("worst none false-positive rate is not below 10%", failures)


if __name__ == "__main__":
    unittest.main()
