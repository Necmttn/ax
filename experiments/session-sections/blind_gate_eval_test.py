import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_gate_eval.py")
spec = importlib.util.spec_from_file_location("session_section_blind_gate_eval", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_gate_eval"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindGateEvalTest(unittest.TestCase):
    def test_validate_rows_rejects_pending_labels(self) -> None:
        rows = [{"id": "r1", "label": "__pending__", "target": "__pending__", "text": "USER:\ncontinue"}]

        with self.assertRaisesRegex(ValueError, "pending labels"):
            module.validate_labeled_rows(rows)

    def test_validate_rows_rejects_unknown_labels(self) -> None:
        rows = [{"id": "r1", "label": "surprise", "target": "none", "text": "USER:\ncontinue"}]

        with self.assertRaisesRegex(ValueError, "unknown labels"):
            module.validate_labeled_rows(rows)

    def test_build_prediction_index_rejects_missing_predictions(self) -> None:
        rows = [{"id": "r1", "label": "none", "target": "none", "text": "USER:\nwhat happened?"}]

        with self.assertRaisesRegex(ValueError, "missing predictions"):
            module.build_prediction_index(rows, [])

    def test_preflight_error_report_is_machine_readable(self) -> None:
        report = module.preflight_error_report(
            ValueError("pending labels remain in blind fixture pack: r1"),
            fixtures_path="fixtures.jsonl",
            predictions_path="predictions.jsonl",
        )

        self.assertEqual(report["schema"], "ax.blind_gate_stack_eval_preflight.v1")
        self.assertEqual(report["decision"], "needs_labeled_blind_fixtures")
        self.assertEqual(report["failures"], ["pending labels remain in blind fixture pack: r1"])

    def test_eval_blind_rows_applies_gates_and_reports_unsafe_none_misses(self) -> None:
        rows = [
            {
                "id": "n1",
                "label": "none",
                "target": "none",
                "text": "USER:\nwhat was the task i gave you?",
            },
            {
                "id": "a1",
                "label": "approval",
                "target": "continue",
                "boundary_group": "approval_start_work",
                "text": "USER:\nokay run it\n\nPREVIOUS_ASSISTANT:\nI described the command.",
            },
            {
                "id": "n2",
                "label": "none",
                "target": "none",
                "text": "USER:\nplain status?",
            },
        ]
        predictions = [
            {"id": "n1", "predicted": "verification_or_recovery_signal"},
            {"id": "a1", "predicted": "verification_or_recovery_signal"},
            {"id": "n2", "predicted": "approval"},
        ]

        report = module.build_report(rows, predictions)

        self.assertEqual(report["schema"], "ax.blind_gate_stack_eval.v1")
        self.assertEqual(report["metrics"]["macro_f1"], 0.6667)
        self.assertEqual(report["metrics"]["none_false_positive_rate"], 0.5)
        self.assertEqual(report["unsafe_none_miss_count"], 1)
        self.assertEqual(report["none_override_count"], 1)
        self.assertEqual(report["family_override_count"], 1)
        self.assertEqual(report["decision"], "needs_gate_stack_work")


if __name__ == "__main__":
    unittest.main()
