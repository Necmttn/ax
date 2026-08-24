import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("eval.py")
spec = importlib.util.spec_from_file_location("session_section_eval", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_eval"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class SessionSectionEvalTest(unittest.TestCase):
    def test_coarse_label_mapping_groups_confusing_event_roles(self) -> None:
        self.assertEqual(module.map_label("direction", "coarse"), "environment_or_preference_signal")
        self.assertEqual(module.map_label("tooling_or_environment_issue", "coarse"), "environment_or_preference_signal")
        self.assertEqual(module.map_label("correction", "coarse"), "correction_or_rejection_signal")
        self.assertEqual(module.map_label("rejection", "coarse"), "correction_or_rejection_signal")
        self.assertEqual(module.map_label("verification_request", "coarse"), "verification_or_recovery_signal")
        self.assertEqual(module.map_label("recovery_action", "coarse"), "verification_or_recovery_signal")
        self.assertEqual(module.map_label("none", "coarse"), "none")

    def test_apply_label_mode_preserves_original_label(self) -> None:
        rows = module.apply_label_mode([{"label": "direction", "text": "USER:\nuse uv"}], "coarse")

        self.assertEqual(rows[0]["label"], "environment_or_preference_signal")
        self.assertEqual(rows[0]["original_label"], "direction")

    def test_split_by_test_ids_uses_fixed_holdout_ids(self) -> None:
        rows = [
            {"id": "case-a", "label": "none", "text": "USER:\na"},
            {"id": "case-b", "label": "direction", "text": "USER:\nb"},
            {"id": "case-c", "label": "approval", "text": "USER:\nc"},
        ]

        train, test = module.split_by_test_ids(rows, {"case-c", "case-a"})

        self.assertEqual([row["id"] for row in train], ["case-b"])
        self.assertEqual([row["id"] for row in test], ["case-a", "case-c"])

    def test_split_by_test_ids_rejects_unknown_ids(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown fixed test ids"):
            module.split_by_test_ids(
                [{"id": "case-a", "label": "none", "text": "USER:\na"}],
                {"missing"},
            )

    def test_grouped_stratified_split_keeps_groups_out_of_both_sides(self) -> None:
        rows = [
            {"id": "a1", "label": "approval", "target": "continue", "text": "USER:\na1"},
            {"id": "a2", "label": "approval", "target": "continue", "text": "USER:\na2"},
            {"id": "a3", "label": "approval", "target": "start", "text": "USER:\na3"},
            {"id": "n1", "label": "none", "target": "question", "text": "USER:\nn1"},
            {"id": "n2", "label": "none", "target": "question", "text": "USER:\nn2"},
            {"id": "n3", "label": "none", "target": "status", "text": "USER:\nn3"},
            {"id": "d1", "label": "direction", "target": "tooling", "text": "USER:\nd1"},
            {"id": "d2", "label": "direction", "target": "runtime", "text": "USER:\nd2"},
            {"id": "d3", "label": "direction", "target": "runtime", "text": "USER:\nd3"},
        ]

        train, test = module.grouped_stratified_split(rows, seed=3, group_field="target", test_fraction=0.34)

        train_groups = {row["target"] for row in train}
        test_groups = {row["target"] for row in test}
        self.assertFalse(train_groups & test_groups)
        self.assertEqual({row["label"] for row in train}, {"approval", "none", "direction"})
        self.assertEqual({row["label"] for row in test}, {"approval", "none", "direction"})

    def test_grouped_stratified_split_rejects_missing_group_field(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing group field"):
            module.grouped_stratified_split(
                [{"id": "case-a", "label": "none", "text": "USER:\na"}],
                seed=1,
                group_field="target",
            )

    def test_read_test_ids_accepts_json_and_line_files(self) -> None:
        tmp = Path(__file__).with_name(".tmp-test-ids.json")
        try:
            tmp.write_text('{"test_ids": ["case-a", "case-b"]}\n')
            self.assertEqual(module.read_test_ids(str(tmp)), {"case-a", "case-b"})
            tmp.write_text("case-c\n\ncase-d\n")
            self.assertEqual(module.read_test_ids(str(tmp)), {"case-c", "case-d"})
        finally:
            if tmp.exists():
                tmp.unlink()


if __name__ == "__main__":
    unittest.main()
