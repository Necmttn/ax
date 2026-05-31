import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("frozen_embedding.py")
spec = importlib.util.spec_from_file_location("session_section_frozen_embedding", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_frozen_embedding"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class FrozenEmbeddingTest(unittest.TestCase):
    def test_predict_centroid_labels_returns_confidence_margin(self) -> None:
        train_vectors = [
            [1.0, 0.0],
            [0.9, 0.1],
            [0.0, 1.0],
            [0.1, 0.9],
        ]
        train_labels = ["approval", "approval", "none", "none"]
        test_vectors = [
            [0.95, 0.05],
            [0.05, 0.95],
        ]

        predictions = module.predict_centroid_labels(train_vectors, train_labels, test_vectors)

        self.assertEqual([row["label"] for row in predictions], ["approval", "none"])
        self.assertGreater(predictions[0]["confidence"], 0.0)
        self.assertGreater(predictions[0]["margin"], 0.0)

    def test_apply_confidence_threshold_abstains_low_confidence_positives(self) -> None:
        predictions = [
            {"label": "approval", "confidence": 0.39},
            {"label": "approval", "confidence": 0.4},
            {"label": "none", "confidence": 0.1},
        ]

        self.assertEqual(
            module.apply_confidence_threshold(predictions, 0.4),
            ["none", "approval", "none"],
        )

    def test_build_run_report_matches_robustness_shape(self) -> None:
        rows = [
            {"id": "a", "label": "approval"},
            {"id": "b", "label": "none"},
        ]
        labels = ["approval", "none"]
        predictions = ["approval", "approval"]
        scored = [
            {"label": "approval", "confidence": 0.9, "margin": 0.7},
            {"label": "approval", "confidence": 0.6, "margin": 0.2},
        ]

        report = module.build_run_report(
            seed=7,
            train_rows=4,
            test_rows=rows,
            labels=labels,
            predictions=predictions,
            scored_predictions=scored,
            train_seconds=0.25,
            predict_seconds=0.05,
            calibration_threshold=0.7,
        )

        self.assertEqual(report["seed"], 7)
        self.assertEqual(report["train_rows"], 4)
        self.assertEqual(report["test_rows"], 2)
        self.assertEqual(report["macro_f1"], 0.3333)
        self.assertEqual(report["none_false_positive_rate"], 1.0)
        self.assertEqual(report["calibrated"]["examples"][1]["predicted"], "none")


if __name__ == "__main__":
    unittest.main()
