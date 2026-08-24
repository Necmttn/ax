import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("promotion_plan.py")
spec = importlib.util.spec_from_file_location("session_section_promotion_plan", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_promotion_plan"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class PromotionPlanTest(unittest.TestCase):
    def test_create_promotion_plan_promotes_accepted_and_revised_candidates(self) -> None:
        plan = module.create_promotion_plan({
            "candidates": [
                {
                    "candidate_id": "section_candidate:verification_loop",
                    "section_type": "verification_loop",
                    "proposed_action": "add_verification_gate",
                    "sections": 2,
                    "verdict": "accept",
                    "rationale": "useful verification gate",
                    "examples": [{"evidence": ["turn:1", "tool_call:1"]}],
                },
                {
                    "candidate_id": "section_candidate:preference_discovery",
                    "section_type": "preference_discovery",
                    "proposed_action": "record_guidance_or_environment_preference",
                    "sections": 1,
                    "verdict": "revise",
                    "rationale": "split by preference type before persistence",
                    "examples": [{"evidence": ["turn:2"]}],
                },
            ]
        })

        self.assertEqual(plan["failures"], [])
        self.assertEqual(plan["promotable_candidates"], 2)
        self.assertEqual(plan["facts"][0]["fact_type"], "candidate_verification_gate")
        self.assertEqual(len(plan["evidence_edges"]), 3)

    def test_create_promotion_plan_blocks_pending_candidates(self) -> None:
        plan = module.create_promotion_plan({
            "candidates": [
                {
                    "candidate_id": "section_candidate:correction_loop",
                    "verdict": "pending",
                    "examples": [{"evidence": ["turn:1"]}],
                }
            ]
        })

        self.assertEqual(plan["pending_candidate_ids"], ["section_candidate:correction_loop"])
        self.assertIn("review still has pending candidates", plan["failures"])
        self.assertIn("no reviewed candidates", plan["failures"])

    def test_create_promotion_plan_blocks_noisy_review(self) -> None:
        plan = module.create_promotion_plan({
            "candidates": [
                {
                    "candidate_id": "a",
                    "verdict": "accept",
                    "rationale": "useful",
                    "examples": [{"evidence": ["turn:a"]}],
                },
                {
                    "candidate_id": "b",
                    "verdict": "reject",
                    "rationale": "noisy",
                    "examples": [{"evidence": ["turn:b"]}],
                },
            ]
        })

        self.assertEqual(plan["reject_rate"], 0.5)
        self.assertIn("manual review reject rate is not below 30%", plan["failures"])

    def test_create_promotion_plan_requires_rationale_and_evidence(self) -> None:
        plan = module.create_promotion_plan({
            "candidates": [
                {
                    "candidate_id": "section_candidate:verification_loop",
                    "proposed_action": "add_verification_gate",
                    "verdict": "accept",
                    "rationale": "",
                    "examples": [{"evidence": []}],
                }
            ]
        })

        self.assertEqual(plan["reviewed_candidates_missing_rationale"], ["section_candidate:verification_loop"])
        self.assertEqual(plan["promotable_candidates_missing_evidence"], ["section_candidate:verification_loop"])
        self.assertIn("reviewed candidates are missing rationales", plan["failures"])
        self.assertIn("promotable candidates are missing evidence", plan["failures"])


if __name__ == "__main__":
    unittest.main()
