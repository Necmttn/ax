import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("candidate_graph_projection.py")
spec = importlib.util.spec_from_file_location("candidate_graph_projection", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["candidate_graph_projection"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def usefulness_report() -> dict:
    return {
        "schema": "ax.setfit_gate_stack_graph_usefulness_report.v1",
        "decision": "candidate_graph_usefulness",
        "runs": [{
            "seed": 7,
            "test_rows": 2,
            "predicted_positive_count": 1,
            "model_assisted_candidate_count": 1,
            "graph_noise_count": 0,
            "accepted_hard_negative_miss_count": 0,
            "candidate_groups": [{
                "label": "correction_or_rejection_signal",
                "candidate_id": "section_candidate:correction_loop",
                "proposed_action": "add_context_guardrail",
                "support_count": 1,
                "true_positive_count": 1,
                "wrong_family_count": 0,
                "fixture_evidence_count": 1,
                "examples": [{
                    "id": "fixture/correction",
                    "actual": "correction_or_rejection_signal",
                    "predicted": "correction_or_rejection_signal",
                    "source_group": "session-section-chunks",
                    "text_excerpt": "USER: that status is wrong",
                }],
            }],
        }],
    }


class CandidateGraphProjectionTest(unittest.TestCase):
    def test_projection_builds_candidate_group_fact_and_evidence_edge(self) -> None:
        projection = module.projection_from_usefulness(usefulness_report(), ".ax/experiments/usefulness.json")

        self.assertEqual(projection["decision"], "candidate_graph_projection_ready")
        self.assertEqual(projection["health"]["decision"], "healthy")
        self.assertEqual(projection["health"]["candidate_group_count"], 1)
        self.assertEqual(projection["health"]["fixture_evidence_edge_count"], 1)
        self.assertIn("classifier_candidate_group", {fact["kind"] for fact in projection["facts"]})
        self.assertIn("classifier_candidate_evidence", {fact["kind"] for fact in projection["facts"]})
        self.assertIn("supported_by_fixture", {edge["kind"] for edge in projection["edges"]})
        self.assertIn("suggests_action", {edge["kind"] for edge in projection["edges"]})
        evidence_node = next(node for node in projection["nodes"] if node["kind"] == "classifier_fixture_evidence")
        self.assertNotIn("predicted", evidence_node["properties"])
        self.assertEqual(evidence_node["properties"]["source_group"], "session-section-chunks")

    def test_projection_health_fails_group_without_evidence_or_action(self) -> None:
        health = module.graph_health_from_projection(
            [{"id": "group:1", "kind": "classifier_candidate_group", "label": "demo", "properties": {}}],
            [],
            [],
        )

        self.assertEqual(health["decision"], "needs_review")
        self.assertIn("candidate groups missing fixture evidence edges", health["failures"])
        self.assertIn("candidate groups missing suggested action edges", health["failures"])

    def test_write_plan_targets_generic_classifier_graph_tables(self) -> None:
        projection = module.projection_from_usefulness(usefulness_report(), ".ax/experiments/usefulness.json")
        write_plan = module.write_plan_from_projection(projection)

        self.assertEqual(write_plan["decision"], "ready_to_apply")
        self.assertEqual(write_plan["tables"], ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"])
        self.assertEqual(
            write_plan["totals"]["statement_count"],
            write_plan["totals"]["node_statement_count"] + write_plan["totals"]["edge_statement_count"] + write_plan["totals"]["fact_statement_count"],
        )
        self.assertTrue(any(statement.startswith("UPSERT classifier_graph_node:") for statement in write_plan["statements"]))
        self.assertTrue(any(statement.startswith("UPSERT classifier_graph_edge:") for statement in write_plan["statements"]))
        self.assertTrue(any(statement.startswith("UPSERT classifier_graph_fact:") for statement in write_plan["statements"]))


if __name__ == "__main__":
    unittest.main()
