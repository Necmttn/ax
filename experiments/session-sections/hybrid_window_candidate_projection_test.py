import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("hybrid_window_candidate_projection.py")
spec = importlib.util.spec_from_file_location("hybrid_window_candidate_projection", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["hybrid_window_candidate_projection"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def candidate(row_id: str, label: str, evidence: list[dict[str, str]] | None = None) -> dict:
    return {
        "id": f"event_window:{row_id}",
        "label": label,
        "confidence": 0.82,
        "run_reason": "unlabeled",
        "session": "session:demo",
        "turn": f"turn:{row_id}",
        "seq": 5,
        "ts": "2026-05-31T00:00:00Z",
        "approx_tokens": 220,
        "evidence": evidence if evidence is not None else [{"kind": "previous_assistant", "ref": "turn:prev"}],
        "text_excerpt": f"USER: useful context for {row_id}",
    }


def candidate_without_evidence(row_id: str, label: str) -> dict:
    row = candidate(row_id, label, evidence=[])
    row["turn"] = None
    return row


class HybridWindowCandidateProjectionTest(unittest.TestCase):
    def test_projection_builds_graph_ready_model_only_candidate_groups(self) -> None:
        projection = module.projection_from_hybrid_report(
            {
                "windows": 100,
                "deterministic_positive_count": 20,
                "setfit_sent_count": 30,
                "setfit_run_rate": 0.3,
                "model_only_positive_count": 3,
                "model_only_evidence_coverage": 1.0,
                "useful_new_fact_rate": 0.15,
                "failures": [],
                "model_only_candidates": [
                    candidate("preference", "environment_or_preference_signal"),
                    candidate("correction", "correction_or_rejection_signal"),
                    candidate("verification", "verification_or_recovery_signal"),
                ],
            },
            ".ax/experiments/hybrid-gate.json",
        )

        self.assertEqual(projection["decision"], "hybrid_window_candidate_graph_projection_ready")
        self.assertEqual(projection["health"]["decision"], "healthy")
        self.assertEqual(projection["totals"]["candidate_group_count"], 3)
        self.assertEqual(projection["health"]["transcript_evidence_edge_count"], 6)
        self.assertIn("classifier_candidate_group", {fact["kind"] for fact in projection["facts"]})
        self.assertIn("classifier_candidate_evidence", {fact["kind"] for fact in projection["facts"]})
        self.assertIn("supported_by_model_window", {edge["kind"] for edge in projection["edges"]})
        self.assertIn("cites_transcript_evidence", {edge["kind"] for edge in projection["edges"]})

    def test_projection_fails_when_model_only_candidate_has_no_evidence(self) -> None:
        projection = module.projection_from_hybrid_report(
            {
                "setfit_run_rate": 0.3,
                "model_only_evidence_coverage": 0.0,
                "useful_new_fact_rate": 0.2,
                "failures": [],
                "model_only_candidates": [candidate_without_evidence("missing", "approval")],
            },
            ".ax/experiments/hybrid-gate.json",
        )

        self.assertEqual(projection["decision"], "needs_hybrid_window_candidate_graph_projection_work")
        self.assertIn("model-window candidates missing transcript evidence", projection["health"]["failures"])
        self.assertIn("source hybrid gate model-only evidence coverage below 100%", projection["health"]["failures"])

    def test_write_plan_targets_classifier_graph_tables(self) -> None:
        projection = module.projection_from_hybrid_report(
            {
                "setfit_run_rate": 0.3,
                "model_only_evidence_coverage": 1.0,
                "useful_new_fact_rate": 0.2,
                "failures": [],
                "model_only_candidates": [candidate("approval", "approval")],
            },
            ".ax/experiments/hybrid-gate.json",
        )
        write_plan = module.write_plan_from_projection(projection)

        self.assertEqual(write_plan["decision"], "ready_to_apply")
        self.assertEqual(write_plan["tables"], ["classifier_graph_node", "classifier_graph_edge", "classifier_graph_fact"])
        self.assertTrue(any(statement.startswith("UPSERT classifier_graph_node:") for statement in write_plan["statements"]))


if __name__ == "__main__":
    unittest.main()
