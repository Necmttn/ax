import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("experiment_summary.py")
spec = importlib.util.spec_from_file_location("session_section_experiment_summary", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_experiment_summary"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class ExperimentSummaryTest(unittest.TestCase):
    def test_summarize_artifacts_marks_manual_review_blockers(self) -> None:
        summary = module.summarize_artifacts(
            {"none_false_positive_rate": 0.72},
            {"macro_f1": 0.24, "none_false_positive_rate": 0.0},
            {"macro_f1": 0.44},
            {"setfit_run_rate": 0.34, "useful_new_fact_rate": 0.2, "model_only_evidence_coverage": 1.0},
            {"boundary_overlap": 1.0, "evidence_coverage": 1.0},
            {"model_assisted_candidate_count": 3},
            {"candidates": 3, "reviewable": 3, "reviewed": 0, "pending": 3, "reject_rate": None, "failures": ["pending"]},
            {"promotable_candidates": 0, "pending_candidates": 3, "facts": [], "evidence_edges": [], "failures": ["pending"]},
        )

        self.assertEqual(summary["recommendation"], "revise")
        self.assertEqual(summary["embedding_decision"], "reject_plain_embedding_classifier")
        self.assertIn("review_all_candidates_reviewed", summary["remaining_blockers"])
        self.assertIn("promotion_plan_ready", summary["remaining_blockers"])

    def test_summarize_artifacts_can_pass_after_review_and_promotion(self) -> None:
        summary = module.summarize_artifacts(
            {"none_false_positive_rate": 0.0},
            {"macro_f1": 0.8, "none_false_positive_rate": 0.0},
            {"macro_f1": 0.8},
            {"setfit_run_rate": 0.34, "useful_new_fact_rate": 0.2, "model_only_evidence_coverage": 1.0},
            {"boundary_overlap": 1.0, "evidence_coverage": 1.0},
            {"model_assisted_candidate_count": 3},
            {"candidates": 3, "reviewable": 3, "reviewed": 3, "pending": 0, "reject_rate": 0.0, "failures": []},
            {"promotable_candidates": 3, "pending_candidates": 0, "facts": [{}, {}, {}], "evidence_edges": [{}, {}], "failures": []},
        )

        self.assertEqual(summary["recommendation"], "adopt")
        self.assertEqual(summary["failed_gate_count"], 0)


if __name__ == "__main__":
    unittest.main()
