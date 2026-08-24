import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("boundary_replay_graph_projection.py")
spec = importlib.util.spec_from_file_location("session_section_boundary_replay_graph_projection", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_boundary_replay_graph_projection"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def replay() -> dict:
    return {
        "schema": "ax.boundary_review_deterministic_replay.v1",
        "decision": "deterministic_boundary_replay_complete",
        "classifier_key": "correction-event",
        "rows": [{
            "id": "workflow-candidate-topic/review_coverage/correction_or_rejection_signal/lhseid",
            "actual": "correction_or_rejection_signal",
            "current_label": "correction",
            "target": "workflow_state",
            "covered_by_deterministic": True,
            "deterministic_results": [{
                "classifier_key": "correction-event",
                "label": "correction",
                "target": "workflow_state",
                "confidence": 0.84,
                "signals": ["correction:workflow_state"],
            }],
        }],
    }


class BoundaryReplayGraphProjectionTest(unittest.TestCase):
    def test_projects_covered_boundary_replay_to_graph_facts(self) -> None:
        projection = module.projection_from_replay(replay(), "replay.json")

        self.assertEqual(projection["schema"], "ax.boundary_replay_graph_projection.v1")
        self.assertEqual(projection["decision"], "boundary_replay_graph_projection_ready")
        self.assertEqual(projection["totals"]["covered_fact_count"], 1)
        self.assertEqual(projection["totals"]["deterministic_label_fact_count"], 1)
        predicates = [fact["predicate"] for fact in projection["facts"]]
        self.assertIn("covered_by_deterministic", predicates)
        self.assertIn("deterministic_label", predicates)

    def test_builds_ready_write_plan_with_boundary_source_kind(self) -> None:
        projection = module.projection_from_replay(replay(), "replay.json")
        write_plan = module.write_plan_from_projection(projection)

        self.assertEqual(write_plan["schema"], "ax.boundary_replay_graph_surreal_write_plan.v1")
        self.assertEqual(write_plan["decision"], "ready_to_apply")
        self.assertGreater(write_plan["totals"]["statement_count"], 0)
        self.assertTrue(all("boundary_replay_deterministic_projection" in statement for statement in write_plan["statements"]))


if __name__ == "__main__":
    unittest.main()
