import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("embedding_helper_graph_projection.py")
spec = importlib.util.spec_from_file_location("session_section_embedding_helper_graph_projection", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_embedding_helper_graph_projection"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def helper_review() -> dict:
    return {
        "schema": "ax.embedding_helper_review.v1",
        "decision": "ready_for_helper_review",
        "model": "sentence-transformers/all-MiniLM-L6-v2",
        "classifier": "svm",
        "label_mode": "coarse",
        "routing": {
            "decision": "routing_candidate_ready_for_review",
            "min_positive_recall": 0.9,
            "recommended_threshold": {
                "threshold": "none",
                "setfit_call_reduction_rate_mean": 0.1778,
                "positive_recall_after_routing_mean": 0.9028,
                "none_rejection_precision_mean": 0.5833,
                "none_rejection_recall_mean": 0.5,
                "positive_false_rejections_mean": 2.33,
            },
        },
        "hard_negative_candidates": [{
            "source_fixture_id": "session-section-chunks/none-start-building",
            "status": "pending_human_acceptance",
            "proposed_label": "none",
            "seed_count": 2,
            "seen_in_seeds": [7, 13],
            "predicted_label_counts": {"approval": 1, "none": 1},
            "max_confidence": 0.35,
            "max_margin": 0.1801,
            "max_nearest_positive_similarity": 0.8743,
            "review_instruction": "Accept only after review.",
            "nearest_neighbors": [
                {"id": "session-section-chunks/none-go", "label": "none", "similarity": 0.857},
                {"id": "session-section-chunks/approval-alright-go", "label": "approval", "similarity": 0.8565},
            ],
        }],
        "dedupe_clusters": [{
            "id": "embedding-dedupe-cluster/1",
            "status": "pending_review",
            "source_fixture_ids": [
                "session-section-chunks/correction-commit-claim-wrong",
                "session-section-chunks/correction-uncommitted-after-claim",
            ],
            "labels": {"correction_or_rejection_signal": 2},
            "review_instruction": "Review whether this evidence should count once.",
        }],
        "failures": [],
    }


class EmbeddingHelperGraphProjectionTest(unittest.TestCase):
    def test_projection_builds_advisory_helper_facts(self) -> None:
        projection = module.projection_from_review(helper_review(), ".ax/experiments/embedding-helper-review.json")

        self.assertEqual(projection["decision"], "embedding_helper_graph_projection_ready")
        self.assertEqual(projection["health"]["decision"], "healthy")
        self.assertEqual(projection["totals"]["routing_candidate_fact_count"], 1)
        self.assertEqual(projection["totals"]["hard_negative_candidate_fact_count"], 1)
        self.assertEqual(projection["totals"]["dedupe_cluster_fact_count"], 1)
        self.assertEqual(projection["totals"]["nearest_neighbor_edge_count"], 2)
        self.assertIn("embedding_helper_routing_candidate", {fact["kind"] for fact in projection["facts"]})
        self.assertIn("embedding_helper_hard_negative_candidate", {fact["kind"] for fact in projection["facts"]})
        self.assertIn("embedding_helper_dedupe_cluster", {fact["kind"] for fact in projection["facts"]})

    def test_projection_health_blocks_unready_review(self) -> None:
        review = {**helper_review(), "decision": "needs_helper_review_inputs"}
        projection = module.projection_from_review(review, ".ax/experiments/embedding-helper-review.json")

        self.assertEqual(projection["decision"], "needs_embedding_helper_graph_projection_work")
        self.assertIn("source helper review is not ready_for_helper_review", projection["health"]["failures"])

    def test_projection_health_requires_nearest_neighbor_evidence(self) -> None:
        review = helper_review()
        review["hard_negative_candidates"][0]["nearest_neighbors"] = []
        projection = module.projection_from_review(review, ".ax/experiments/embedding-helper-review.json")

        self.assertEqual(projection["decision"], "needs_embedding_helper_graph_projection_work")
        self.assertIn("hard-negative candidates missing nearest-neighbor evidence", projection["health"]["failures"])

    def test_write_plan_targets_classifier_graph_tables(self) -> None:
        projection = module.projection_from_review(helper_review(), ".ax/experiments/embedding-helper-review.json")
        write_plan = module.write_plan_from_projection(projection)

        self.assertEqual(write_plan["decision"], "ready_to_apply")
        self.assertEqual(write_plan["tables"], ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"])
        self.assertEqual(
            write_plan["totals"]["statement_count"],
            write_plan["totals"]["node_statement_count"] + write_plan["totals"]["edge_statement_count"] + write_plan["totals"]["fact_statement_count"],
        )
        self.assertTrue(any("embedding_helper_review_projection" in statement for statement in write_plan["statements"]))


if __name__ == "__main__":
    unittest.main()
