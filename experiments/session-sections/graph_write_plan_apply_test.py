import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("graph_write_plan_apply.py")
spec = importlib.util.spec_from_file_location("graph_write_plan_apply", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["graph_write_plan_apply"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def write_plan(decision: str = "ready_to_apply") -> dict:
    return {
        "schema": "ax.demo_write_plan.v1",
        "source_projection_schema": "ax.demo_projection.v1",
        "decision": decision,
        "tables": ["classifier_graph_node"],
        "statements": [
            "UPSERT classifier_graph_node:`a` CONTENT {};",
            "UPSERT classifier_graph_node:`b` CONTENT {};",
        ],
    }


class GraphWritePlanApplyTest(unittest.TestCase):
    def test_apply_report_applies_all_statements(self) -> None:
        applied: list[str] = []

        report = module.apply_report(write_plan(), "plan.json", applied.append)

        self.assertEqual(report["decision"], "applied")
        self.assertTrue(report["applied"])
        self.assertEqual(report["applied_statement_count"], 2)
        self.assertEqual(applied, write_plan()["statements"])

    def test_apply_report_supports_dry_run_without_applying(self) -> None:
        applied: list[str] = []

        report = module.apply_report(write_plan(), "plan.json", applied.append, dry_run=True)

        self.assertEqual(report["decision"], "dry_run_ready")
        self.assertFalse(report["applied"])
        self.assertEqual(report["attempted_statement_count"], 2)
        self.assertEqual(applied, [])

    def test_apply_report_blocks_non_ready_write_plan(self) -> None:
        report = module.apply_report(write_plan("blocked"), "plan.json", lambda _: None)

        self.assertEqual(report["decision"], "blocked")
        self.assertIn("write plan is not ready_to_apply", report["failures"])

    def test_apply_report_captures_first_failure(self) -> None:
        def fail_on_second(statement: str) -> None:
            if "`b`" in statement:
                raise RuntimeError("boom")

        report = module.apply_report(write_plan(), "plan.json", fail_on_second)

        self.assertEqual(report["decision"], "failed")
        self.assertEqual(report["applied_statement_count"], 1)
        self.assertEqual(report["first_failure"]["index"], 1)
        self.assertEqual(report["first_failure"]["message"], "boom")

    def test_apply_batched_report_applies_statements_in_one_call(self) -> None:
        batches: list[list[str]] = []

        report = module.apply_batched_report(write_plan(), "plan.json", batches.append)

        self.assertEqual(report["decision"], "applied")
        self.assertEqual(report["applied_statement_count"], 2)
        self.assertEqual(batches, [write_plan()["statements"]])


if __name__ == "__main__":
    unittest.main()
