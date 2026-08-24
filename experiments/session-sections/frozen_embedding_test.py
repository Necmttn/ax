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

    def test_parse_thresholds_accepts_none_and_numbers(self) -> None:
        self.assertEqual(module.parse_thresholds("none,0.2,0.4"), [None, 0.2, 0.4])

    def test_routing_metrics_reports_call_reduction_and_positive_recall(self) -> None:
        labels = ["approval", "none", "correction", "none"]
        scored = [
            {"label": "approval", "confidence": 0.8},
            {"label": "none", "confidence": 0.6},
            {"label": "correction", "confidence": 0.2},
            {"label": "approval", "confidence": 0.9},
        ]

        metrics = module.routing_metrics(labels, scored, 0.4)

        self.assertEqual(metrics["rejected_as_none"], 2)
        self.assertEqual(metrics["sent_to_stronger_classifier"], 2)
        self.assertEqual(metrics["setfit_call_reduction_rate"], 0.5)
        self.assertEqual(metrics["none_rejection_precision"], 0.5)
        self.assertEqual(metrics["none_rejection_recall"], 0.5)
        self.assertEqual(metrics["positive_recall_after_routing"], 0.5)
        self.assertEqual(metrics["positive_false_rejections"], 1)

    def test_nearest_neighbors_and_summary_explain_predictions(self) -> None:
        train_rows = [
            {"id": "train-a", "label": "approval"},
            {"id": "train-n", "label": "none"},
        ]
        train_vectors = [[1.0, 0.0], [0.0, 1.0]]
        test_rows = [{"id": "test-a", "label": "approval"}]
        test_vectors = [[0.9, 0.1]]
        scored = [{"label": "approval", "confidence": 0.9, "margin": 0.8}]

        neighbors = module.nearest_neighbors(train_rows, train_vectors, test_rows, test_vectors, 2)
        summary = module.nearest_neighbor_summary(test_rows, scored, neighbors)

        self.assertEqual(neighbors[0][0]["id"], "train-a")
        self.assertEqual(summary["top1_actual_label_match_rate"], 1.0)
        self.assertEqual(summary["topk_predicted_label_support_rate"], 1.0)

    def test_hard_negative_candidates_find_none_near_positive(self) -> None:
        rows = [{"id": "none-a", "label": "none"}]
        scored = [{"label": "approval", "confidence": 0.7, "margin": 0.2}]
        neighbors = [[
            {"id": "train-a", "label": "approval", "similarity": 0.85},
            {"id": "train-n", "label": "none", "similarity": 0.75},
        ]]

        candidates = module.hard_negative_candidates(rows, scored, neighbors, 5)

        self.assertEqual(candidates[0]["id"], "none-a")
        self.assertEqual(candidates[0]["nearest_positive_similarity"], 0.85)

    def test_dedupe_summary_clusters_near_duplicate_vectors(self) -> None:
        rows = [
            {"id": "a", "label": "approval"},
            {"id": "b", "label": "approval"},
            {"id": "c", "label": "none"},
        ]
        vectors = [
            [1.0, 0.0],
            [0.99, 0.01],
            [0.0, 1.0],
        ]

        summary = module.dedupe_summary(rows, vectors, 0.98)

        self.assertEqual(summary["duplicate_cluster_count"], 1)
        self.assertEqual(summary["duplicate_row_count"], 2)
        self.assertEqual(summary["max_cluster_size"], 2)

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
        neighbors = [
            [{"id": "train-a", "label": "approval", "similarity": 0.9}],
            [{"id": "train-b", "label": "none", "similarity": 0.8}],
        ]

        report = module.build_run_report(
            seed=7,
            train_rows=4,
            test_rows=rows,
            labels=labels,
            predictions=predictions,
            scored_predictions=scored,
            neighbor_rows=neighbors,
            train_seconds=0.25,
            predict_seconds=0.05,
            calibration_threshold=0.7,
            routing_thresholds=[None, 0.7],
            hard_negative_limit=10,
        )

        self.assertEqual(report["seed"], 7)
        self.assertEqual(report["train_rows"], 4)
        self.assertEqual(report["test_rows"], 2)
        self.assertEqual(report["macro_f1"], 0.3333)
        self.assertEqual(report["none_false_positive_rate"], 1.0)
        self.assertEqual(report["helper"]["routing"]["setfit_call_reduction_rate"], 0.5)
        self.assertEqual(len(report["helper"]["routing_sweep"]), 2)
        self.assertEqual(report["raw_predictions_with_confidence"][0]["nearest_neighbors"][0]["id"], "train-a")
        self.assertEqual(report["calibrated"]["examples"][1]["predicted"], "none")


if __name__ == "__main__":
    unittest.main()
