import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("split_audit.py")
spec = importlib.util.spec_from_file_location("session_section_split_audit", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_split_audit"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class SplitAuditTest(unittest.TestCase):
    def test_audit_split_reports_label_and_group_overlap(self) -> None:
        train = [
            {"id": "a1", "label": "approval", "target": "continue", "pair": "continue_boundary"},
            {"id": "n1", "label": "none", "target": "question", "pair": "question_boundary"},
        ]
        test = [
            {"id": "a2", "label": "approval", "target": "start", "pair": "start_boundary"},
            {"id": "n2", "label": "none", "target": "status", "pair": "question_boundary"},
        ]

        audit = module.audit_split(train, test, "target", "pair")

        self.assertEqual(audit["train_rows"], 2)
        self.assertEqual(audit["test_rows"], 2)
        self.assertEqual(audit["train_labels"], {"approval": 1, "none": 1})
        self.assertEqual(audit["test_labels"], {"approval": 1, "none": 1})
        self.assertEqual(audit["overlap_groups"], [])
        self.assertEqual(audit["overlap_pair_groups"], ["question_boundary"])

    def test_label_group_summary_reports_monolithic_labels(self) -> None:
        rows = [
            {"id": "a1", "label": "approval", "target": "continue"},
            {"id": "a2", "label": "approval", "target": "continue"},
            {"id": "n1", "label": "none", "target": "question"},
            {"id": "n2", "label": "none", "target": "status"},
        ]

        summary = module.label_group_summary(rows, "target")

        self.assertEqual(summary["approval"]["group_count"], 1)
        self.assertEqual(summary["approval"]["largest_group_rows"], 2)
        self.assertTrue(summary["approval"]["monolithic"])
        self.assertEqual(summary["none"]["group_count"], 2)
        self.assertFalse(summary["none"]["monolithic"])

    def test_audit_seeds_marks_unviable_group_split(self) -> None:
        rows = [
            {"id": "a1", "label": "approval", "target": "continue", "text": "USER:\na"},
            {"id": "n1", "label": "none", "target": "question", "text": "USER:\nn"},
        ]

        report = module.audit_seeds(rows, [1], "target")

        self.assertEqual(report["runs"][0]["decision"], "unviable_split")
        self.assertIn("without test rows", report["runs"][0]["error"])

    def test_audit_seeds_marks_pair_overlap_as_leaky(self) -> None:
        rows = [
            {"id": "a1", "label": "approval", "target": "approval_a", "pair": "boundary_a", "text": "USER:\na"},
            {"id": "a2", "label": "approval", "target": "approval_b", "pair": "boundary_b", "text": "USER:\na"},
            {"id": "n1", "label": "none", "target": "none_a", "pair": "boundary_a", "text": "USER:\nn"},
            {"id": "n2", "label": "none", "target": "none_b", "pair": "boundary_c", "text": "USER:\nn"},
        ]

        report = module.audit_seeds(rows, [1], "target", "pair")

        self.assertEqual(report["pair_field"], "pair")
        self.assertEqual(report["runs"][0]["decision"], "leaky_split")
        self.assertEqual(report["runs"][0]["overlap_groups"], [])
        self.assertEqual(report["runs"][0]["overlap_pair_groups"], ["boundary_a"])


if __name__ == "__main__":
    unittest.main()
