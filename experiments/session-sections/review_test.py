import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("review.py")
spec = importlib.util.spec_from_file_location("session_section_review", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_review"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class ReviewTest(unittest.TestCase):
    def test_generate_review_marks_candidates_pending_with_examples(self) -> None:
        review = module.generate_review({
            "candidate_groups": [
                {
                    "candidate_id": "section_candidate:verification_loop",
                    "section_type": "verification_loop",
                    "sections": 7,
                    "proposed_action": "add_verification_gate",
                }
            ]
        }, {
            "session_reports": [
                {
                    "session": "fixture-session-01",
                    "predicted": [
                        {
                            "section_type": "verification_loop",
                            "start_seq": 6,
                            "end_seq": 7,
                            "labels": ["verification_request", "recovery_action"],
                            "evidence": ["turn:01-6", "tool_call:01-c"],
                        },
                        {
                            "section_type": "preference_discovery",
                            "start_seq": 8,
                            "end_seq": 8,
                            "labels": ["direction"],
                            "evidence": ["turn:01-8"],
                        },
                    ],
                }
            ]
        })

        self.assertEqual(review["candidates"][0]["verdict"], "pending")
        self.assertIn("Accept if examples show recurring need for tests", review["candidates"][0]["review_criteria"][0])
        self.assertEqual(review["candidates"][0]["examples"], [
            {
                "session": "fixture-session-01",
                "start_seq": 6,
                "end_seq": 7,
                "labels": ["verification_request", "recovery_action"],
                "evidence": ["turn:01-6", "tool_call:01-c"],
            }
        ])

    def test_section_examples_respects_limit(self) -> None:
        examples = module.section_examples_by_type({
            "session_reports": [
                {
                    "session": "fixture-session-01",
                    "predicted": [
                        {"section_type": "correction_loop", "start_seq": 1, "end_seq": 1},
                        {"section_type": "correction_loop", "start_seq": 2, "end_seq": 2},
                    ],
                }
            ]
        }, 1)

        self.assertEqual(len(examples["correction_loop"]), 1)

    def test_evaluate_review_computes_reject_rate(self) -> None:
        report = module.evaluate_review({
            "candidates": [
                {"candidate_id": "a", "verdict": "accept", "rationale": "useful", "examples": [{"evidence": ["turn:a"]}]},
                {"candidate_id": "b", "verdict": "revise", "rationale": "too broad", "examples": [{"evidence": ["turn:b"]}]},
                {"candidate_id": "c", "verdict": "reject", "rationale": "noisy", "examples": [{"evidence": ["turn:c"]}]},
            ]
        })

        self.assertEqual(report["reject_rate"], 0.3333)
        self.assertIn("manual review reject rate is not below 30%", report["failures"])

    def test_evaluate_review_passes_below_reject_threshold(self) -> None:
        report = module.evaluate_review({
            "candidates": [
                {"candidate_id": "a", "verdict": "accept", "rationale": "useful", "examples": [{"evidence": ["turn:a"]}]},
                {"candidate_id": "b", "verdict": "revise", "rationale": "needs narrower action", "examples": [{"evidence": ["turn:b"]}]},
                {"candidate_id": "c", "verdict": "accept", "rationale": "useful", "examples": [{"evidence": ["turn:c"]}]},
            ]
        })

        self.assertEqual(report["reject_rate"], 0.0)
        self.assertEqual(report["failures"], [])

    def test_evaluate_review_requires_examples_and_evidence(self) -> None:
        report = module.evaluate_review({
            "candidates": [
                {"candidate_id": "a", "verdict": "accept", "rationale": "useful"},
                {"candidate_id": "b", "verdict": "accept", "rationale": "useful", "examples": [{"evidence": []}]},
            ]
        })

        self.assertEqual(report["reviewable"], 0)
        self.assertEqual(report["candidates_missing_examples"], ["a"])
        self.assertEqual(report["candidates_missing_evidence"], ["b"])
        self.assertIn("review candidates are missing examples", report["failures"])
        self.assertIn("review candidates are missing evidence-backed examples", report["failures"])

    def test_evaluate_review_requires_rationale_for_reviewed_candidates(self) -> None:
        report = module.evaluate_review({
            "candidates": [
                {"candidate_id": "a", "verdict": "accept", "rationale": "", "examples": [{"evidence": ["turn:a"]}]},
                {"candidate_id": "b", "verdict": "pending", "rationale": "", "examples": [{"evidence": ["turn:b"]}]},
            ]
        })

        self.assertEqual(report["reviewed_candidates_missing_rationale"], ["a"])
        self.assertIn("reviewed candidates are missing rationales", report["failures"])

    def test_render_markdown_brief_includes_candidate_examples(self) -> None:
        brief = module.render_markdown_brief({
            "instructions": "Review these.",
            "candidates": [
                {
                    "candidate_id": "section_candidate:verification_loop",
                    "section_type": "verification_loop",
                    "sections": 2,
                    "proposed_action": "add_verification_gate",
                    "verdict": "pending",
                    "rationale": "",
                    "examples": [
                        {
                            "session": "fixture-session-01",
                            "start_seq": 6,
                            "end_seq": 7,
                            "labels": ["verification_request"],
                            "evidence": ["turn:01-6"],
                        }
                    ],
                }
            ],
        })

        self.assertIn("# Graph Usefulness Candidate Review", brief)
        self.assertIn("section_candidate:verification_loop", brief)
        self.assertIn("Review criteria:", brief)
        self.assertIn("`fixture-session-01` seq `6`-`7`", brief)
        self.assertIn("`turn:01-6`", brief)

    def test_parse_markdown_review_extracts_verdicts_and_rationales(self) -> None:
        updates = module.parse_markdown_review("""
# Graph Usefulness Candidate Review

## section_candidate:verification_loop

- Section type: `verification_loop`
- Verdict: `accept`
- Rationale: clear evidence-backed verification loop

## section_candidate:correction_loop

- Verdict: revise
- Rationale: needs tighter grouping
""")

        self.assertEqual(updates["section_candidate:verification_loop"], {
            "verdict": "accept",
            "rationale": "clear evidence-backed verification loop",
        })
        self.assertEqual(updates["section_candidate:correction_loop"], {
            "verdict": "revise",
            "rationale": "needs tighter grouping",
        })

    def test_sync_review_from_markdown_updates_known_candidates(self) -> None:
        review = {
            "candidates": [
                {
                    "candidate_id": "section_candidate:verification_loop",
                    "verdict": "pending",
                    "rationale": "",
                    "examples": [{"evidence": ["turn:01-6"]}],
                }
            ]
        }

        synced = module.sync_review_from_markdown(review, """
## section_candidate:verification_loop

- Verdict: `accept`
- Rationale: useful recurring pattern
""")

        self.assertEqual(synced["candidates"][0]["verdict"], "accept")
        self.assertEqual(synced["candidates"][0]["rationale"], "useful recurring pattern")
        self.assertEqual(review["candidates"][0]["verdict"], "pending")


if __name__ == "__main__":
    unittest.main()
