import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_candidate_proposal_promote_smoke.py")
spec = importlib.util.spec_from_file_location("workflow_candidate_proposal_promote_smoke", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.path.insert(0, str(SCRIPT_PATH.parent))
sys.modules["workflow_candidate_proposal_promote_smoke"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class WorkflowCandidateProposalPromoteSmokeTest(unittest.TestCase):
    def test_build_smoke_emits_accept_and_revise_drafts_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            smoke = module.build_smoke(
                str(root / "review.json"),
                str(root / "promotion.json"),
                str(root / "drafts"),
            )

            self.assertEqual(smoke["decision"], "workflow_candidate_proposal_ready_smoke_passed")
            self.assertEqual(smoke["review_decision"], "workflow_candidate_proposal_reviews_ready")
            self.assertEqual(smoke["promotion_decision"], "workflow_candidate_proposal_promotion_ready")
            self.assertEqual(smoke["emitted_draft_count"], 2)
            self.assertEqual(smoke["skipped_proposal_count"], 1)
            self.assertEqual(len(list((root / "drafts").glob("*.md"))), 2)
            self.assertTrue((root / "review.json").exists())
            self.assertTrue((root / "promotion.json").exists())


if __name__ == "__main__":
    unittest.main()
