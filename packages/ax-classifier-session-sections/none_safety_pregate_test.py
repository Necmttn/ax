import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("none_safety_pregate.py")
spec = importlib.util.spec_from_file_location("session_section_none_safety_pregate", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_none_safety_pregate"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class NoneSafetyPreGateTest(unittest.TestCase):
    def test_none_safety_reason_catches_repeated_false_positive_patterns(self) -> None:
        cases = [
            (
                {
                    "name": "none-continue",
                    "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was already executing the agreed plan.",
                },
                "already_executing_continue",
            ),
            (
                {
                    "name": "none-model-size-question",
                    "text": "USER:\nhow large is the trained model and where would contributors download it from?",
                },
                "model_artifact_question",
            ),
            (
                {
                    "name": "none-task-recall",
                    "text": "USER:\nwhat was the task i gave you?\n\nPREVIOUS_ASSISTANT:\nThe user wants context recall.",
                },
                "context_recall_question",
            ),
        ]

        for row, reason in cases:
            self.assertEqual(module.none_safety_reason(row), reason)

    def test_none_safety_reason_does_not_catch_approval_continue(self) -> None:
        row = {
            "name": "approval-continue",
            "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was mid-way through the classifier goal and had a passing checkpoint.",
        }

        self.assertIsNone(module.none_safety_reason(row))

    def test_none_safety_reason_does_not_catch_eval_gate_command(self) -> None:
        row = {
            "name": "verification-regression",
            "text": "USER:\nadd a test mechanism so trained models do not regress silently\n\nPREVIOUS_ASSISTANT:\nI discussed training but not eval gates.",
        }

        self.assertIsNone(module.none_safety_reason(row))

    def test_none_safety_reason_does_not_catch_eval_mechanism_question(self) -> None:
        row = {
            "name": "verification-eval-question",
            "text": "USER:\ncan we have a test or eval mechanism for trained models?\n\nPREVIOUS_ASSISTANT:\nI proposed classifier evals.",
        }

        self.assertIsNone(module.none_safety_reason(row))

    def test_build_report_accepts_gate_when_none_false_positives_are_fixed(self) -> None:
        report = {
            "schema": "ax.setfit_robustness_report.v1",
            "model": "test-model",
            "decision": "needs_model_quality_work",
            "failures": ["worst none false-positive rate is not below 10%"],
            "runs": [
                {
                    "seed": 7,
                    "calibrated": {
                        "examples": [
                            {"id": "none-continue", "actual": "none", "predicted": "verification_or_recovery_signal"},
                            {"id": "approval-start", "actual": "approval", "predicted": "approval"},
                        ],
                    },
                }
            ],
        }
        fixtures = {
            "none-continue": {
                "id": "none-continue",
                "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was already executing the agreed plan.",
            },
            "approval-start": {
                "id": "approval-start",
                "text": "USER:\nyes build it\n\nPREVIOUS_ASSISTANT:\nI proposed implementation.",
            },
        }

        result = module.build_report(report, fixtures)

        self.assertEqual(result["decision"], "candidate_none_safety_pregate")
        self.assertEqual(result["summary"]["before"]["none_false_positive_rate_max"], 1.0)
        self.assertEqual(result["summary"]["after"]["none_false_positive_rate_max"], 0.0)
        self.assertEqual(result["summary"]["fixed_none_false_positive_count_total"], 1)
        self.assertEqual(result["summary"]["harmful_override_count_total"], 0)

    def test_build_report_rejects_harmful_overrides(self) -> None:
        report = {
            "runs": [
                {
                    "seed": 7,
                    "examples": [
                        {"id": "verification-eval", "actual": "verification_or_recovery_signal", "predicted": "verification_or_recovery_signal"},
                    ],
                }
            ],
        }
        fixtures = {
            "verification-eval": {
                "id": "verification-eval",
                "text": "USER:\nwhat was the task i gave you?\n\nPREVIOUS_ASSISTANT:\nThe user asks for context recall, but this fixture marks it as a signal.",
            },
        }

        result = module.build_report(report, fixtures)

        self.assertEqual(result["decision"], "reject_none_safety_pregate")
        self.assertEqual(result["summary"]["harmful_override_count_total"], 1)


if __name__ == "__main__":
    unittest.main()
