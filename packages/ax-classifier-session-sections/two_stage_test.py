import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("two_stage.py")
spec = importlib.util.spec_from_file_location("session_section_two_stage", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_two_stage"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class TwoStageTest(unittest.TestCase):
    def test_binary_label_maps_none_and_actionable(self) -> None:
        self.assertEqual(module.binary_label("none"), "none")
        self.assertEqual(module.binary_label("approval"), "actionable")
        self.assertEqual(module.binary_label("verification_or_recovery_signal"), "actionable")

    def test_binary_rows_preserve_original_label(self) -> None:
        rows = [
            {"id": "n1", "label": "none", "text": "USER:\nstatus"},
            {"id": "a1", "label": "approval", "text": "USER:\ngo"},
        ]

        projected = module.binary_rows(rows)

        self.assertEqual(projected[0]["label"], "none")
        self.assertEqual(projected[0]["family_label"], "none")
        self.assertEqual(projected[1]["label"], "actionable")
        self.assertEqual(projected[1]["family_label"], "approval")

    def test_actionable_rows_exclude_none(self) -> None:
        rows = [
            {"id": "n1", "label": "none", "text": "USER:\nstatus"},
            {"id": "a1", "label": "approval", "text": "USER:\ngo"},
            {"id": "v1", "label": "verification_or_recovery_signal", "text": "USER:\ntest it"},
        ]

        actionable = module.actionable_rows(rows)

        self.assertEqual([row["id"] for row in actionable], ["a1", "v1"])

    def test_final_predictions_use_family_only_when_binary_is_actionable(self) -> None:
        binary_predictions = ["none", "actionable", "actionable", "none"]
        family_predictions = ["approval", "verification_or_recovery_signal"]

        final = module.final_predictions(binary_predictions, family_predictions)

        self.assertEqual(final, ["none", "approval", "verification_or_recovery_signal", "none"])

    def test_final_predictions_rejects_unused_family_predictions(self) -> None:
        with self.assertRaisesRegex(ValueError, "unused family predictions"):
            module.final_predictions(["none"], ["approval"])


if __name__ == "__main__":
    unittest.main()
