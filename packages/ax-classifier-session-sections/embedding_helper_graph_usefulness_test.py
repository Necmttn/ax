import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("embedding_helper_graph_usefulness.py")
spec = importlib.util.spec_from_file_location("embedding_helper_graph_usefulness", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["embedding_helper_graph_usefulness"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def graph_health() -> dict:
    return {
        "schema": "ax.classifier_package_execution_graph_health_report.v1",
        "embedding_helper_facts": [{
            "predicate": "promoted_hard_negative_fixture",
            "source_fixture_id": "session-section-chunks/none-next-step",
            "status": "accepted",
            "proposed_label": "none",
            "evidence_paths": [".ax/experiments/embedding-helper-review-current.json"],
        }],
    }


def fixtures() -> list[dict]:
    return [{
        "id": "session-section-chunks/none-next-step",
        "label": "none",
        "target": "none",
        "text": "USER:\nwhat is next?",
    }]


def workflow_report() -> dict:
    return {
        "schema": "ax.workflow_candidate_report.v1",
        "source_kind": "hybrid_window_classifier_projection",
        "decision": "workflow_candidates_ranked",
        "totals": {"candidate_group_count": 1},
        "candidates": [{
            "group_id": "group:approval",
            "label": "approval",
            "proposed_action": "record_approval_checkpoint",
            "support_count": 3,
            "examples": [{
                "turn": "turn:1",
                "text_excerpt": "USER: what is next?",
                "confidence": 0.8,
            }],
        }],
    }


class EmbeddingHelperGraphUsefulnessTest(unittest.TestCase):
    def test_report_identifies_candidate_examples_matching_promoted_none_controls(self) -> None:
        report = module.build_report(
            graph_health=graph_health(),
            fixtures=fixtures(),
            workflow_reports=[workflow_report()],
            workflow_report_paths=["workflow.json"],
        )

        self.assertEqual(report["decision"], "embedding_helper_graph_usefulness_ready")
        self.assertEqual(report["summary"]["promoted_helper_fact_count"], 1)
        self.assertEqual(report["summary"]["matched_candidate_example_count"], 1)
        self.assertEqual(report["summary"]["candidate_group_with_matches_count"], 1)
        candidate = report["workflow_reports"][0]["candidates"][0]
        self.assertEqual(candidate["adjusted_support_count"], 2)
        self.assertEqual(candidate["scanned_example_count"], 1)
        self.assertEqual(candidate["unscanned_support_count"], 2)
        self.assertEqual(candidate["helper_matches"][0]["source_fixture_id"], "session-section-chunks/none-next-step")
        self.assertEqual(report["summary"]["example_coverage_ratio"], 0.3333)

    def test_report_blocks_without_promoted_helper_facts(self) -> None:
        report = module.build_report(
            graph_health={"embedding_helper_facts": []},
            fixtures=fixtures(),
            workflow_reports=[workflow_report()],
            workflow_report_paths=["workflow.json"],
        )

        self.assertEqual(report["decision"], "needs_embedding_helper_graph_usefulness_inputs")
        self.assertIn("no promoted helper hard-negative facts found", report["failures"])


if __name__ == "__main__":
    unittest.main()
