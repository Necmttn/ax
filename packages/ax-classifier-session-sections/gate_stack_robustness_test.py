import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("gate_stack_robustness.py")
spec = importlib.util.spec_from_file_location("session_section_gate_stack_robustness", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_gate_stack_robustness"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class GateStackRobustnessTest(unittest.TestCase):
    def test_eval_run_applies_none_and_family_gates(self) -> None:
        run = {
            "seed": 7,
            "examples": [
                {"id": "none-model", "actual": "none", "predicted": "approval"},
                {"id": "approval-continue", "actual": "approval", "predicted": "verification_or_recovery_signal"},
            ],
        }
        fixtures = {
            "none-model": {
                "id": "none-model",
                "text": "USER:\nhow large is the model artifact?\n\nPREVIOUS_ASSISTANT:\nI discussed package download.",
            },
            "approval-continue": {
                "id": "approval-continue",
                "boundary_group": "approval_resume_work",
                "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was mid-way through the work.",
            },
        }

        result = module.eval_run(run, fixtures)

        self.assertEqual(result["seed"], 7)
        self.assertEqual(result["macro_f1"], 1.0)
        self.assertEqual(result["none_false_positive_rate"], 0.0)
        self.assertEqual(result["none_override_count"], 1)
        self.assertEqual(result["family_override_count"], 1)
        self.assertEqual(result["examples"], [
            {"id": "none-model", "actual": "none", "predicted": "none"},
            {"id": "approval-continue", "actual": "approval", "predicted": "approval"},
        ])

    def test_build_report_summarizes_multiple_runs(self) -> None:
        report = {
            "schema": "ax.setfit_two_stage_report.v1",
            "model": "test-model",
            "runs": [
                {
                    "seed": 7,
                    "examples": [
                        {"id": "a1", "actual": "approval", "predicted": "approval"},
                        {"id": "n1", "actual": "none", "predicted": "none"},
                    ],
                },
                {
                    "seed": 13,
                    "examples": [
                        {"id": "a1", "actual": "approval", "predicted": "none"},
                        {"id": "n1", "actual": "none", "predicted": "none"},
                    ],
                },
            ],
        }
        fixtures = {
            "a1": {"id": "a1", "text": "USER:\ncontinue"},
            "n1": {"id": "n1", "text": "USER:\nwhat happened?"},
        }

        result = module.build_report(report, fixtures)

        self.assertEqual(result["schema"], "ax.setfit_gate_stack_robustness_report.v1")
        self.assertEqual(result["summary"]["runs"], 2)
        self.assertEqual(result["summary"]["macro_f1_min"], 0.3333)
        self.assertEqual(result["summary"]["none_false_positive_rate_max"], 0.0)
        self.assertEqual(result["decision"], "needs_gate_stack_work")


if __name__ == "__main__":
    unittest.main()
