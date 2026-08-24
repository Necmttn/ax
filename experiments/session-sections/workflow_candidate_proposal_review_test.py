import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_candidate_proposal_review.py")
spec = importlib.util.spec_from_file_location("workflow_candidate_proposal_review", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["workflow_candidate_proposal_review"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def write_brief(root: Path, name: str, body: str) -> str:
    path = root / name
    path.write_text(body)
    return str(path)


def proposal(brief_path: str) -> dict:
    return {
        "id": "workflow-candidate-proposal:01-add-verification-gate",
        "title": "Add a verification gate for recurring agent work",
        "action": "add_verification_gate",
        "recommended_artifact": "harness",
        "brief_path": brief_path,
    }


class WorkflowCandidateProposalReviewTest(unittest.TestCase):
    def test_pending_brief_blocks_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brief_path = write_brief(root, "proposal.md", """
# Add a verification gate for recurring agent work

- Proposal id: `workflow-candidate-proposal:01-add-verification-gate`

## Reviewer Decision

- Verdict: `pending`
- Rationale:
- Proposed change:
- Target file/skill/harness:
""")

            report = module.build_report({"proposals": [proposal(brief_path)]}, "pack.json")

            self.assertEqual(report["decision"], "needs_workflow_candidate_proposal_review")
            self.assertEqual(report["totals"]["ready_count"], 0)
            self.assertEqual(report["totals"]["pending_count"], 1)
            self.assertEqual(report["totals"]["missing_field_count"], 4)
            self.assertEqual(
                report["proposals"][0]["missing_fields"],
                ["verdict", "rationale", "proposed_change", "target"],
            )

    def test_filled_brief_is_promotion_ready(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brief_path = write_brief(root, "proposal.md", """
# Add a verification gate for recurring agent work

- Proposal id: `workflow-candidate-proposal:01-add-verification-gate`

## Reviewer Decision

- Verdict: `accept`
- Rationale: This evidence shows repeated verification claims.
- Proposed change: Add a harness that checks test and typecheck claims before completion.
- Target file/skill/harness: tests/workflow/verification-claim.test.ts
""")

            report = module.build_report({"proposals": [proposal(brief_path)]}, "pack.json")

            self.assertEqual(report["decision"], "workflow_candidate_proposal_reviews_ready")
            self.assertEqual(report["totals"]["ready_count"], 1)
            self.assertEqual(report["proposals"][0]["review"]["verdict"], "accept")
            self.assertEqual(report["proposals"][0]["missing_fields"], [])
            self.assertEqual(report["proposals"][0]["invalid_fields"], [])

    def test_invalid_verdict_blocks_promotion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brief_path = write_brief(root, "proposal.md", """
# Add a verification gate for recurring agent work

- Proposal id: `workflow-candidate-proposal:01-add-verification-gate`

## Reviewer Decision

- Verdict: `ship_it`
- Rationale: This evidence shows repeated verification claims.
- Proposed change: Add a harness that checks test and typecheck claims before completion.
- Target file/skill/harness: tests/workflow/verification-claim.test.ts
""")

            report = module.build_report({"proposals": [proposal(brief_path)]}, "pack.json")

            self.assertEqual(report["decision"], "needs_workflow_candidate_proposal_review")
            self.assertEqual(report["totals"]["invalid_count"], 1)
            self.assertEqual(report["proposals"][0]["invalid_fields"], ["verdict"])

    def test_render_summary_points_reviewer_at_missing_fields_and_brief(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brief_path = write_brief(root, "proposal.md", """
# Add a verification gate for recurring agent work

- Proposal id: `workflow-candidate-proposal:01-add-verification-gate`

## Reviewer Decision

- Verdict: `pending`
- Rationale:
- Proposed change:
- Target file/skill/harness:
""")

            report = module.build_report({"proposals": [proposal(brief_path)]}, "pack.json")
            summary = module.render_summary(report)

            self.assertIn("Workflow Candidate Proposal Review", summary)
            self.assertIn(f"Brief: `{brief_path}`", summary)
            self.assertIn("Missing fields: `verdict, rationale, proposed_change, target`", summary)
            self.assertIn("Verdict", summary)


if __name__ == "__main__":
    unittest.main()
