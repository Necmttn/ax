import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("graph_usefulness.py")
spec = importlib.util.spec_from_file_location("session_section_graph_usefulness", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_graph_usefulness"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class GraphUsefulnessTest(unittest.TestCase):
    def test_section_candidates_map_to_actions(self) -> None:
        candidates = module.section_candidates({
            "predicted_type_counts": {
                "preference_discovery": 2,
                "correction_loop": 1,
                "verification_loop": 3,
            }
        })

        self.assertEqual(len(candidates), 3)
        self.assertEqual(candidates[0]["candidate_id"], "section_candidate:correction_loop")
        self.assertEqual(
            {candidate["proposed_action"] for candidate in candidates},
            {"record_guidance_or_environment_preference", "add_context_guardrail", "add_verification_gate"},
        )

    def test_evaluate_usefulness_passes_when_hybrid_and_sections_are_evidence_backed(self) -> None:
        report = module.evaluate_usefulness(
            {
                "deterministic_positive_count": 10,
                "model_only_positive_count": 3,
                "useful_new_fact_rate": 0.3,
                "model_only_evidence_coverage": 1.0,
            },
            {
                "predicted_sections": 6,
                "evidence_coverage": 1.0,
                "predicted_type_counts": {
                    "preference_discovery": 2,
                    "correction_loop": 2,
                    "verification_loop": 2,
                },
            },
        )

        self.assertEqual(report["failures"], [])
        self.assertEqual(report["model_assisted_candidate_count"], 3)

    def test_evaluate_usefulness_reports_missing_candidate_groups(self) -> None:
        report = module.evaluate_usefulness(
            {"deterministic_positive_count": 10, "model_only_positive_count": 0, "useful_new_fact_rate": 0, "model_only_evidence_coverage": 1},
            {"predicted_sections": 1, "evidence_coverage": 1, "predicted_type_counts": {"preference_discovery": 1}},
        )

        self.assertIn("less than 3 model-assisted candidate groups", report["failures"])
        self.assertIn("useful new fact rate below 10%", report["failures"])


if __name__ == "__main__":
    unittest.main()
