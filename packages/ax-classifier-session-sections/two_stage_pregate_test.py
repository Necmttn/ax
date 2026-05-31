import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("two_stage_pregate.py")
spec = importlib.util.spec_from_file_location("session_section_two_stage_pregate", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_two_stage_pregate"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class TwoStagePreGateTest(unittest.TestCase):
    def test_none_gate_catches_model_size_question(self) -> None:
        row = {
            "name": "none-model-size-question",
            "label": "none",
            "text": "USER:\nhow large is the trained model and where would contributors download it from?\n\nPREVIOUS_ASSISTANT:\nI discussed package installation.",
        }

        self.assertEqual(module.none_gate_reason(row), "model_artifact_question")

    def test_none_gate_catches_completed_next_step_question(self) -> None:
        row = {
            "name": "none-whats-next-after-complete",
            "label": "none",
            "text": "USER:\nwhats next?\n\nPREVIOUS_ASSISTANT:\nI completed the current goal and listed verification results.",
        }

        self.assertEqual(module.none_gate_reason(row), "completed_workflow_next_question")

    def test_none_gate_catches_already_executing_continue(self) -> None:
        row = {
            "name": "none-continue",
            "label": "none",
            "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was already executing the agreed plan.",
        }

        self.assertEqual(module.none_gate_reason(row), "already_executing_continue")

    def test_none_gate_does_not_catch_approval_continue(self) -> None:
        row = {
            "name": "approval-continue",
            "label": "approval",
            "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was mid-way through the classifier goal and had a passing checkpoint.",
        }

        self.assertIsNone(module.none_gate_reason(row))

    def test_none_gate_catches_context_recall_question(self) -> None:
        row = {
            "name": "none-task-recall",
            "label": "none",
            "text": "USER:\nwhat was the task i gave you?\n\nPREVIOUS_ASSISTANT:\nThe user wants context recall.",
        }

        self.assertEqual(module.none_gate_reason(row), "context_recall_question")

    def test_none_gate_catches_classifier_capacity_question(self) -> None:
        row = {
            "name": "none-size-question",
            "label": "none",
            "text": "USER:\nhow big is the text that we can classify?\n\nPREVIOUS_ASSISTANT:\nI introduced SetFit and embeddings.",
        }

        self.assertEqual(module.none_gate_reason(row), "classifier_capacity_question")

    def test_none_gate_catches_git_hygiene_request(self) -> None:
        row = {
            "name": "none-commit-request",
            "label": "none",
            "text": "USER:\ncommit any uncommitted work before we continue\n\nPREVIOUS_ASSISTANT:\nI had finished a batch of work.",
        }

        self.assertEqual(module.none_gate_reason(row), "git_hygiene_question")

    def test_apply_none_gate_overrides_only_matched_rows(self) -> None:
        fixtures = {
            "n1": {
                "id": "n1",
                "text": "USER:\nhow large is the trained model?\n\nPREVIOUS_ASSISTANT:\nI discussed model downloads.",
            },
            "a1": {
                "id": "a1",
                "text": "USER:\nship it\n\nPREVIOUS_ASSISTANT:\nI proposed the next implementation.",
            },
        }
        examples = [
            {"id": "n1", "actual": "none", "predicted": "environment_or_preference_signal"},
            {"id": "a1", "actual": "approval", "predicted": "approval"},
        ]

        predictions, overrides = module.apply_none_gate(examples, fixtures)

        self.assertEqual(predictions, ["none", "approval"])
        self.assertEqual(overrides, [{"id": "n1", "reason": "model_artifact_question"}])


if __name__ == "__main__":
    unittest.main()
