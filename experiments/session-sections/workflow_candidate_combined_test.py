import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_candidate_combined.py")
spec = importlib.util.spec_from_file_location("workflow_candidate_combined", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["workflow_candidate_combined"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def report(source_kind: str, candidates: list[dict]) -> dict:
    return {
        "decision": "workflow_candidates_ranked",
        "source_kind": source_kind,
        "totals": {
            "candidate_group_count": len(candidates),
            "evidence_fact_count": sum(int(candidate["evidence_count"]) for candidate in candidates),
            "wrapper_like_count": 0,
            "task_like_count": sum(int(candidate.get("task_like_count") or 0) for candidate in candidates),
        },
        "candidates": candidates,
    }


def candidate(label: str, action: str, support: int = 3, evidence: int = 3, task_like: int = 0) -> dict:
    return {
        "label": label,
        "proposed_action": action,
        "support_count": support,
        "evidence_count": evidence,
        "task_like_count": task_like,
        "wrapper_like_count": 0,
        "score": 1.0,
    }


class WorkflowCandidateCombinedTest(unittest.TestCase):
    def test_build_report_combines_sources_by_action(self) -> None:
        combined = module.build_report(
            report("transcript_classifier_projection", [
                candidate("verification-event:test", "add_verification_gate", 10, 10, 2),
                candidate("reaction-event:correction", "add_context_guardrail", 4, 4),
                candidate("direction-event:tooling", "record_guidance_or_environment_preference", 2, 2),
            ]),
            report("hybrid_window_classifier_projection", [
                candidate("verification_or_recovery_signal", "add_verification_gate", 8, 8),
                candidate("correction_or_rejection_signal", "add_context_guardrail", 3, 3),
                candidate("environment_or_preference_signal", "record_guidance_or_environment_preference", 5, 5),
            ]),
            "baseline.json",
            "hybrid.json",
        )

        self.assertEqual(combined["decision"], "workflow_candidate_sources_combined")
        self.assertEqual(combined["summary"]["action_count"], 3)
        self.assertEqual(combined["summary"]["shared_action_count"], 3)
        verification = next(row for row in combined["actions"] if row["action"] == "add_verification_gate")
        self.assertEqual(verification["total_support_count"], 18)
        self.assertEqual(verification["sources"][0]["source_kind"], "transcript_classifier_projection")
        self.assertEqual(verification["sources"][1]["source_kind"], "hybrid_window_classifier_projection")

    def test_build_report_fails_when_sources_do_not_share_actions(self) -> None:
        combined = module.build_report(
            report("transcript_classifier_projection", [
                candidate("verification-event:test", "add_verification_gate"),
            ]),
            report("hybrid_window_classifier_projection", [
                candidate("approval", "record_approval_checkpoint"),
            ]),
            "baseline.json",
            "hybrid.json",
        )

        self.assertEqual(combined["decision"], "needs_workflow_candidate_combination_review")
        self.assertIn("fewer than 2 graph actions are shared across sources", combined["failures"])


if __name__ == "__main__":
    unittest.main()
