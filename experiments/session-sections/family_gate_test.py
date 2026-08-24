import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("family_gate.py")
spec = importlib.util.spec_from_file_location("session_section_family_gate", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_family_gate"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class FamilyGateTest(unittest.TestCase):
    def test_approval_resume_overrides_verification_prediction(self) -> None:
        row = {
            "id": "approval-continue",
            "boundary_group": "approval_resume_work",
            "text": "Assistant: I am midway through the plan.\nUser: continue",
        }

        prediction, reason = module.family_gate_label(row, "verification_or_recovery_signal")

        self.assertEqual(prediction, "approval")
        self.assertEqual(reason, "approval_resume_gate")

    def test_approval_start_overrides_verification_prediction(self) -> None:
        row = {
            "id": "approval-okay-run-it",
            "boundary_group": "approval_start_work",
            "text": "USER:\nokay run it\n\nPREVIOUS_ASSISTANT:\nI described the command that would train the local SetFit model.",
        }

        prediction, reason = module.family_gate_label(row, "verification_or_recovery_signal")

        self.assertEqual(prediction, "approval")
        self.assertEqual(reason, "approval_start_gate")

    def test_correction_workflow_overrides_environment_prediction(self) -> None:
        row = {
            "id": "correction-dirty-files-question",
            "text": "Assistant: I said classifier work was committed.\nUser: is there still any dirty files left?",
        }

        prediction, reason = module.family_gate_label(row, "environment_or_preference_signal")

        self.assertEqual(prediction, "correction_or_rejection_signal")
        self.assertEqual(reason, "correction_boundary_gate")

    def test_correction_status_wrong_overrides_verification_prediction(self) -> None:
        row = {
            "id": "correction-status-was-wrong",
            "text": "USER:\nthat status is wrong, you already ran that command and it failed",
        }

        prediction, reason = module.family_gate_label(row, "verification_or_recovery_signal")

        self.assertEqual(prediction, "correction_or_rejection_signal")
        self.assertEqual(reason, "correction_boundary_gate")

    def test_tooling_environment_overrides_none_prediction(self) -> None:
        row = {
            "id": "tooling-docker-compose",
            "text": "Can we start Surreal through docker compose so we have a predictable dev environment?",
        }

        prediction, reason = module.family_gate_label(row, "none")

        self.assertEqual(prediction, "environment_or_preference_signal")
        self.assertEqual(reason, "tooling_environment_gate")

    def test_recovery_cleanup_overrides_environment_prediction(self) -> None:
        row = {
            "id": "recovery-clean-generated",
            "text": "I removed generated __pycache__ artifacts after Python tests and checked the dirty files left.",
        }

        prediction, reason = module.family_gate_label(row, "environment_or_preference_signal")

        self.assertEqual(prediction, "verification_or_recovery_signal")
        self.assertEqual(reason, "recovery_worktree_gate")

    def test_non_tooling_none_prediction_stays_none(self) -> None:
        row = {
            "id": "none-whats-next-after-complete",
            "text": "What is next after the completed verification summary?",
        }

        prediction, reason = module.family_gate_label(row, "none")

        self.assertEqual(prediction, "none")
        self.assertIsNone(reason)

    def test_blind_review_request_overrides_environment_prediction(self) -> None:
        row = {
            "id": "review-request",
            "text": "USER:\nYou are a code-quality reviewer for Task 1. Review commits only. Do not edit files.",
        }

        prediction, reason = module.family_gate_label(row, "environment_or_preference_signal")

        self.assertEqual(prediction, "verification_or_recovery_signal")
        self.assertEqual(reason, "review_request_gate")

    def test_blind_ordinary_control_overrides_verification_prediction(self) -> None:
        row = {
            "id": "ordinary-next",
            "text": "USER:\nwhat next?\n\nPREVIOUS_ASSISTANT:\nImplemented in isolated worktree with a branch and what landed.",
        }

        prediction, reason = module.family_gate_label(row, "verification_or_recovery_signal")

        self.assertEqual(prediction, "none")
        self.assertEqual(reason, "ordinary_control_gate")

    def test_blind_direct_approval_overrides_environment_prediction(self) -> None:
        row = {
            "id": "approval-admin",
            "text": "USER:\nlets start with admin\n\nPREVIOUS_ASSISTANT:\nI opened a visual companion with entry-point options.",
        }

        prediction, reason = module.family_gate_label(row, "environment_or_preference_signal")

        self.assertEqual(prediction, "approval")
        self.assertEqual(reason, "direct_approval_gate")

    def test_blind_correction_overrides_verification_prediction(self) -> None:
        row = {
            "id": "correction-reuse",
            "text": "USER:\nCan you reuse the existing stuff instead of re-inventing waveform registration?",
        }

        prediction, reason = module.family_gate_label(row, "verification_or_recovery_signal")

        self.assertEqual(prediction, "correction_or_rejection_signal")
        self.assertEqual(reason, "blind_correction_gate")

    def test_blind_reference_context_overrides_environment_prediction(self) -> None:
        row = {
            "id": "macbook-reference",
            "text": "USER:\nTo keep your MacBook running with the lid closed, use Clamshell Mode with external monitor and power adapter.",
        }

        prediction, reason = module.family_gate_label(row, "environment_or_preference_signal")

        self.assertEqual(prediction, "none")
        self.assertEqual(reason, "ordinary_context_gate")

    def test_apply_family_gates_records_overrides(self) -> None:
        examples = [
            {"id": "approval-continue", "actual": "approval", "predicted": "verification_or_recovery_signal"},
            {"id": "plain-none", "actual": "none", "predicted": "none"},
        ]
        fixtures = {
            "approval-continue": {
                "id": "approval-continue",
                "boundary_group": "approval_resume_work",
                "text": "Assistant: I am midway through the plan.\nUser: continue",
            },
            "plain-none": {"id": "plain-none", "text": "What happened yesterday?"},
        }

        predictions, overrides = module.apply_family_gates(examples, fixtures)

        self.assertEqual(predictions, ["approval", "none"])
        self.assertEqual(overrides, [
            {
                "id": "approval-continue",
                "from": "verification_or_recovery_signal",
                "to": "approval",
                "reason": "approval_resume_gate",
            },
        ])


if __name__ == "__main__":
    unittest.main()
