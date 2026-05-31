import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("embedding_helper_review.py")
spec = importlib.util.spec_from_file_location("session_section_embedding_helper_review", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_embedding_helper_review"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def helper_report() -> dict:
    return {
        "schema": "ax.frozen_embedding_robustness_report.v1",
        "model": "sentence-transformers/all-MiniLM-L6-v2",
        "classifier": "svm",
        "label_mode": "coarse",
        "dedupe": {
            "examples": [[
                {"id": "fixture/a", "label": "correction_or_rejection_signal"},
                {"id": "fixture/b", "label": "correction_or_rejection_signal"},
            ]],
        },
        "runs": [
            {
                "seed": 7,
                "raw_predictions_with_confidence": [
                    {
                        "id": "fixture/none-a",
                        "nearest_neighbors": [
                            {"id": "fixture/positive-a", "label": "approval", "similarity": 0.8},
                        ],
                    },
                ],
                "helper": {
                    "routing_sweep": [
                        {
                            "threshold": None,
                            "setfit_call_reduction_rate": 0.2,
                            "positive_recall_after_routing": 0.95,
                            "none_rejection_precision": 0.5,
                            "none_rejection_recall": 0.6,
                            "positive_false_rejections": 1,
                        },
                        {
                            "threshold": 0.4,
                            "setfit_call_reduction_rate": 0.8,
                            "positive_recall_after_routing": 0.4,
                            "none_rejection_precision": 0.3,
                            "none_rejection_recall": 0.9,
                            "positive_false_rejections": 6,
                        },
                    ],
                    "hard_negative_candidates": [
                        {
                            "id": "fixture/none-a",
                            "predicted": "approval",
                            "confidence": 0.7,
                            "margin": 0.3,
                            "nearest_positive_similarity": 0.8,
                        },
                    ],
                },
            },
            {
                "seed": 13,
                "raw_predictions_with_confidence": [
                    {
                        "id": "fixture/none-a",
                        "nearest_neighbors": [
                            {"id": "fixture/positive-b", "label": "approval", "similarity": 0.78},
                        ],
                    },
                ],
                "helper": {
                    "routing_sweep": [
                        {
                            "threshold": None,
                            "setfit_call_reduction_rate": 0.3,
                            "positive_recall_after_routing": 0.9,
                            "none_rejection_precision": 0.6,
                            "none_rejection_recall": 0.7,
                            "positive_false_rejections": 2,
                        },
                    ],
                    "hard_negative_candidates": [
                        {
                            "id": "fixture/none-a",
                            "predicted": "approval",
                            "confidence": 0.6,
                            "margin": 0.2,
                            "nearest_positive_similarity": 0.78,
                        },
                    ],
                },
            },
        ],
    }


class EmbeddingHelperReviewTest(unittest.TestCase):
    def test_routing_sweep_summary_selects_safe_threshold(self) -> None:
        summary = module.routing_sweep_summary(helper_report()["runs"], 0.9)

        self.assertEqual(summary["decision"], "routing_candidate_ready_for_review")
        self.assertEqual(summary["recommended_threshold"]["threshold"], "none")
        self.assertEqual(summary["recommended_threshold"]["setfit_call_reduction_rate_mean"], 0.25)
        self.assertEqual(summary["recommended_threshold"]["positive_recall_after_routing_mean"], 0.925)

    def test_aggregate_hard_negatives_merges_seed_evidence(self) -> None:
        candidates = module.aggregate_hard_negatives(helper_report()["runs"], 20)

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["id"], "embedding-hard-negative/fixture/none-a")
        self.assertEqual(candidates[0]["seen_in_seeds"], [7, 13])
        self.assertEqual(candidates[0]["predicted_label_counts"], {"approval": 2})
        self.assertEqual(candidates[0]["nearest_neighbors"][0]["id"], "fixture/positive-a")

    def test_build_review_marks_ready_with_candidates_and_safe_routing(self) -> None:
        review = module.build_review(helper_report(), 0.9, 20)

        self.assertEqual(review["decision"], "ready_for_helper_review")
        self.assertEqual(len(review["hard_negative_candidates"]), 1)
        self.assertEqual(len(review["dedupe_clusters"]), 1)

    def test_build_review_blocks_when_routing_recall_floor_is_not_met(self) -> None:
        review = module.build_review(helper_report(), 0.99, 20)

        self.assertEqual(review["decision"], "needs_helper_review_inputs")
        self.assertIn("no routing threshold met the positive-recall floor", review["failures"])

    def test_render_markdown_includes_review_sections(self) -> None:
        review = module.build_review(helper_report(), 0.9, 20)

        markdown = module.render_markdown(review)

        self.assertIn("# Embedding Helper Review", markdown)
        self.assertIn("## Routing", markdown)
        self.assertIn("## Hard-Negative Candidates", markdown)
        self.assertIn("## Dedupe Clusters", markdown)


if __name__ == "__main__":
    unittest.main()
