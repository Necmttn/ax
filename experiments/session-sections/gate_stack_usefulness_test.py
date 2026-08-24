import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("gate_stack_usefulness.py")
spec = importlib.util.spec_from_file_location("session_section_gate_stack_usefulness", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_gate_stack_usefulness"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def fixture(row_id: str, source_group: str = "session-section-chunks") -> dict[str, str]:
    return {
        "id": row_id,
        "source_group": source_group,
        "text": f"USER: useful context for {row_id}",
    }


class GateStackUsefulnessTest(unittest.TestCase):
    def test_candidate_metadata_maps_known_labels_to_graph_actions(self) -> None:
        self.assertEqual(
            module.candidate_metadata("correction_or_rejection_signal")["proposed_action"],
            "add_context_guardrail",
        )
        self.assertEqual(
            module.candidate_metadata("environment_or_preference_signal")["candidate_id"],
            "section_candidate:preference_discovery",
        )
        self.assertEqual(
            module.candidate_metadata("approval")["candidate_id"],
            "section_candidate:approval_checkpoint",
        )

    def test_build_report_passes_with_evidence_backed_candidate_groups_and_no_noise(self) -> None:
        examples = [
            {"id": "a", "actual": "approval", "predicted": "approval"},
            {"id": "c", "actual": "correction_or_rejection_signal", "predicted": "correction_or_rejection_signal"},
            {"id": "e", "actual": "environment_or_preference_signal", "predicted": "environment_or_preference_signal"},
            {"id": "v", "actual": "verification_or_recovery_signal", "predicted": "verification_or_recovery_signal"},
            {"id": "n", "actual": "none", "predicted": "none"},
        ]
        fixtures = {row_id: fixture(row_id) for row_id in ["a", "c", "e", "v", "n"]}

        report = module.build_report(
            {
                "schema": "source",
                "decision": "candidate_robust_gate_stack",
                "summary": {},
                "runs": [{"seed": 7, "examples": examples}],
            },
            fixtures,
        )

        self.assertEqual(report["decision"], "candidate_graph_usefulness")
        self.assertEqual(report["summary"]["graph_noise_count_total"], 0)
        self.assertEqual(report["summary"]["model_assisted_candidate_count_min"], 4)
        self.assertEqual(report["runs"][0]["fixture_evidence_coverage"], 1.0)

    def test_build_report_fails_on_none_graph_noise_and_hard_negative_miss(self) -> None:
        examples = [
            {"id": "hard", "actual": "none", "predicted": "environment_or_preference_signal"},
            {"id": "c", "actual": "correction_or_rejection_signal", "predicted": "correction_or_rejection_signal"},
            {"id": "e", "actual": "environment_or_preference_signal", "predicted": "environment_or_preference_signal"},
            {"id": "v", "actual": "verification_or_recovery_signal", "predicted": "verification_or_recovery_signal"},
        ]
        fixtures = {
            "hard": fixture("hard", "blind-hard-negative"),
            "c": fixture("c"),
            "e": fixture("e"),
            "v": fixture("v"),
        }

        report = module.build_report(
            {
                "decision": "candidate_robust_gate_stack",
                "runs": [{"seed": 7, "examples": examples}],
            },
            fixtures,
        )

        self.assertEqual(report["decision"], "needs_graph_usefulness_work")
        self.assertEqual(report["summary"]["graph_noise_count_total"], 1)
        self.assertEqual(report["summary"]["accepted_hard_negative_miss_count_total"], 1)
        self.assertIn("gated predictions would add graph noise from none rows", report["summary"]["failures"])


if __name__ == "__main__":
    unittest.main()
