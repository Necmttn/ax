import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_candidate_proposal_promote.py")
spec = importlib.util.spec_from_file_location("workflow_candidate_proposal_promote", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["workflow_candidate_proposal_promote"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def reviewed_proposal(verdict: str = "accept", artifact: str = "harness") -> dict:
    return {
        "id": "workflow-candidate-proposal:01-add-verification-gate",
        "title": "Add a verification gate for recurring agent work",
        "action": "add_verification_gate",
        "recommended_artifact": artifact,
        "brief_path": ".ax/tasks/proposals/01.md",
        "review": {
            "verdict": verdict,
            "rationale": "This evidence shows repeated verification claims.",
            "proposed_change": "Add a harness that checks test and typecheck claims before completion.",
            "target": "tests/workflow/verification-claim.test.ts",
        },
    }


class WorkflowCandidateProposalPromoteTest(unittest.TestCase):
    def test_blocks_when_review_report_is_not_ready(self) -> None:
        report, drafts = module.build_promotion(
            {
                "decision": "needs_workflow_candidate_proposal_review",
                "proposals": [reviewed_proposal()],
            },
            "review.json",
            ".ax/tasks/drafts",
        )

        self.assertEqual(report["decision"], "needs_workflow_candidate_proposal_review")
        self.assertEqual(report["emitted_draft_count"], 0)
        self.assertEqual(report["skipped_proposals"][0]["reason"], "review_not_ready")
        self.assertEqual(drafts, [])

    def test_promotes_accepted_and_revised_proposals_to_task_drafts(self) -> None:
        report, drafts = module.build_promotion(
            {
                "decision": "workflow_candidate_proposal_reviews_ready",
                "proposals": [
                    reviewed_proposal("accept", "harness"),
                    reviewed_proposal("revise", "guidance"),
                    reviewed_proposal("reject", "guidance"),
                ],
            },
            "review.json",
            ".ax/tasks/drafts",
        )

        self.assertEqual(report["decision"], "workflow_candidate_proposal_promotion_ready")
        self.assertEqual(report["emitted_draft_count"], 2)
        self.assertEqual(report["skipped_proposal_count"], 1)
        self.assertIn("Reviewer Rationale", drafts[0]["content"])
        self.assertIn("Create or update an executable harness", drafts[0]["content"])
        self.assertIn("Update the target guidance or skill file", drafts[1]["content"])

    def test_write_drafts_creates_markdown_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            task_dir = str(Path(tmp) / "drafts")
            report, drafts = module.build_promotion(
                {
                    "decision": "workflow_candidate_proposal_reviews_ready",
                    "proposals": [reviewed_proposal()],
                },
                "review.json",
                task_dir,
            )

            module.write_drafts(drafts)

            self.assertEqual(report["emitted_draft_count"], 1)
            written = Path(report["drafts"][0]["task_path"])
            self.assertTrue(written.exists())
            self.assertIn("Source proposal", written.read_text())

    def test_blocked_cli_path_can_still_create_empty_output_dir(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            task_dir = Path(tmp) / "drafts"
            task_dir.mkdir(parents=True, exist_ok=True)

            report, drafts = module.build_promotion(
                {
                    "decision": "needs_workflow_candidate_proposal_review",
                    "proposals": [reviewed_proposal()],
                },
                "review.json",
                str(task_dir),
            )

            self.assertEqual(report["emitted_draft_count"], 0)
            self.assertEqual(drafts, [])
            self.assertEqual(list(task_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
