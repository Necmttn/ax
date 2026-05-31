import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_candidate_compare.py")
spec = importlib.util.spec_from_file_location("workflow_candidate_compare", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["workflow_candidate_compare"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def report(source_kind: str, labels: list[str], evidence: int = 3, wrapper_like: int = 0) -> dict:
    return {
        "decision": "workflow_candidates_ranked",
        "source_kind": source_kind,
        "totals": {
            "candidate_group_count": len(labels),
            "returned_candidate_count": len(labels),
            "evidence_fact_count": evidence,
            "candidate_with_evidence_count": len(labels),
            "wrapper_like_count": wrapper_like,
            "task_like_count": 0,
        },
        "candidates": [
            {
                "label": label,
                "proposed_action": "add_verification_gate" if "verification" in label else "add_context_guardrail",
            }
            for label in labels
        ],
    }


class WorkflowCandidateCompareTest(unittest.TestCase):
    def test_build_report_compares_two_ranked_sources(self) -> None:
        comparison = module.build_report(
            report("transcript_classifier_projection", ["correction", "verification", "direction"], 12),
            report("hybrid_window_classifier_projection", ["correction", "verification", "approval"], 9),
            "baseline.json",
            "candidate.json",
        )

        self.assertEqual(comparison["decision"], "workflow_candidate_sources_compared")
        self.assertEqual(comparison["delta"]["candidate_group_count"], 0)
        self.assertEqual(comparison["delta"]["new_labels"], ["approval"])
        self.assertEqual(comparison["delta"]["shared_labels"], ["correction", "verification"])
        self.assertIn("add_verification_gate", comparison["delta"]["shared_actions"])

    def test_build_report_fails_when_candidate_groups_lack_evidence(self) -> None:
        candidate = report("hybrid_window_classifier_projection", ["correction", "verification", "approval"], 0)
        candidate["totals"]["candidate_with_evidence_count"] = 2

        comparison = module.build_report(
            report("transcript_classifier_projection", ["correction", "verification", "direction"], 12),
            candidate,
            "baseline.json",
            "candidate.json",
        )

        self.assertEqual(comparison["decision"], "needs_workflow_candidate_source_review")
        self.assertIn("candidate source has workflow groups without evidence", comparison["failures"])


if __name__ == "__main__":
    unittest.main()
