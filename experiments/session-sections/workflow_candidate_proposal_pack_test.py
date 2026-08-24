import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_candidate_proposal_pack.py")
spec = importlib.util.spec_from_file_location("workflow_candidate_proposal_pack", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["workflow_candidate_proposal_pack"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def action(action_name: str, evidence: int = 10, task_like: int = 0) -> dict:
    return {
        "action": action_name,
        "total_support_count": evidence,
        "total_evidence_fact_count": evidence,
        "total_task_like_count": task_like,
        "sources": [
            {
                "present": True,
                "source_kind": "transcript_classifier_projection",
                "support_count": evidence,
                "evidence_fact_count": evidence,
                "task_like_count": task_like,
                "labels": ["demo"],
            }
        ],
    }


class WorkflowCandidateProposalPackTest(unittest.TestCase):
    def test_build_report_creates_reviewable_harness_and_guidance_proposals(self) -> None:
        report = module.build_report(
            {
                "decision": "workflow_candidate_sources_combined",
                "actions": [
                    action("add_verification_gate", 20),
                    action("add_context_guardrail", 8),
                    action("record_guidance_or_environment_preference", 6),
                ],
            },
            "combined.json",
            ".ax/tasks/proposals",
            3,
        )

        self.assertEqual(report["decision"], "workflow_candidate_proposal_pack_ready")
        self.assertEqual(report["proposal_count"], 3)
        self.assertEqual(report["recommended_artifacts"]["harness"], 1)
        self.assertEqual(report["recommended_artifacts"]["guidance"], 2)
        self.assertEqual(report["proposals"][0]["action"], "add_verification_gate")

    def test_render_brief_preserves_sources_and_review_fields(self) -> None:
        report = module.build_report(
            {"decision": "workflow_candidate_sources_combined", "actions": [action("add_context_guardrail", 5)]},
            "combined.json",
            ".ax/tasks/proposals",
            1,
        )
        brief = module.render_brief(report["proposals"][0])

        self.assertIn("Reviewer Decision", brief)
        self.assertIn("transcript_classifier_projection", brief)
        self.assertIn("Verdict: `pending`", brief)

    def test_build_report_fails_without_harness_candidate(self) -> None:
        report = module.build_report(
            {"decision": "workflow_candidate_sources_combined", "actions": [action("add_context_guardrail", 5)]},
            "combined.json",
            ".ax/tasks/proposals",
            1,
        )

        self.assertEqual(report["decision"], "needs_workflow_candidate_proposal_review")
        self.assertIn("proposal pack has no harness candidate", report["failures"])


if __name__ == "__main__":
    unittest.main()
