import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("transcript_candidate_projection.py")
spec = importlib.util.spec_from_file_location("transcript_candidate_projection", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["transcript_candidate_projection"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def row(row_id: str, classifier: str, label: str, target: str, text: str) -> dict:
    return {
        "id": f"classifier_result:{row_id}",
        "classifier_key": classifier,
        "classifier_version": "0.1.0",
        "label": label,
        "target": target,
        "polarity": "revise",
        "durability": "session_preference",
        "confidence": 0.82,
        "method": "heuristic",
        "session_id": "session:demo",
        "turn_id": f"turn:{row_id}",
        "turn_seq": 7,
        "turn_text_excerpt": text,
        "ts": "2026-05-30T00:00:00Z",
    }


class TranscriptCandidateProjectionTest(unittest.TestCase):
    def test_projection_groups_real_classifier_results_by_action_with_transcript_evidence(self) -> None:
        projection = module.projection_from_rows(
            [
                row("a", "reaction-event", "approval", "unknown", "yes ship it"),
                row("c", "correction-event", "correction", "wrong_output", "no that is wrong"),
                row("v", "verification-event", "verification_request", "test_required", "run the tests"),
            ],
            [{"result_id": "classifier_result:c", "evidence_id": "turn:prev", "kind": "previous_assistant"}],
            "surrealdb://ax/main/classifier_result",
            50,
            0.74,
        )

        self.assertEqual(projection["decision"], "transcript_candidate_graph_projection_ready")
        self.assertEqual(projection["health"]["decision"], "healthy")
        self.assertEqual(projection["totals"]["candidate_group_count"], 3)
        self.assertEqual(projection["health"]["wrapper_like_result_count"], 0)
        self.assertIn("cites_transcript_evidence", {edge["kind"] for edge in projection["edges"]})
        self.assertIn("classifier_candidate_group", {fact["kind"] for fact in projection["facts"]})

    def test_projection_reports_wrapper_like_results_as_review_warning(self) -> None:
        projection = module.projection_from_rows(
            [row("w", "reaction-event", "direction", "verification", "<subagent_notification>{}")],
            [],
            "surrealdb://ax/main/classifier_result",
            50,
            0.74,
        )

        self.assertEqual(projection["decision"], "transcript_candidate_graph_projection_ready")
        self.assertEqual(projection["health"]["wrapper_like_result_count"], 1)
        self.assertIn("wrapper-like classifier results need review", projection["health"]["review_warnings"])

    def test_write_plan_targets_classifier_graph_tables(self) -> None:
        projection = module.projection_from_rows(
            [row("d", "direction-event", "direction", "tooling_preference", "use uv")],
            [],
            "surrealdb://ax/main/classifier_result",
            50,
            0.74,
        )
        write_plan = module.write_plan_from_projection(projection)

        self.assertEqual(write_plan["decision"], "ready_to_apply")
        self.assertEqual(write_plan["tables"], ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"])
        self.assertTrue(any(statement.startswith("UPSERT classifier_graph_node:") for statement in write_plan["statements"]))


if __name__ == "__main__":
    unittest.main()
