#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("hard_negative_export.py")
spec = importlib.util.spec_from_file_location("session_section_hard_negative_export", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_hard_negative_export"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class HardNegativeExportTest(unittest.TestCase):
    def test_accepted_rows_filters_pending_candidates(self) -> None:
        candidates = [
            {"id": "a", "status": "pending_human_acceptance"},
            {"id": "b", "status": "accepted"},
        ]

        self.assertEqual([row["id"] for row in module.accepted_rows(candidates)], ["b"])

    def test_fixture_row_preserves_source_and_marks_reviewed_none(self) -> None:
        candidate = {
            "id": "pending-hard-negative/blind/a",
            "source_blind_id": "blind/a",
            "proposed_label": "none",
            "proposed_target": "none",
            "text": "USER:\nwhat's next?",
            "risk_reasons": ["possible_none_control_turn"],
        }

        row = module.fixture_row(candidate)

        self.assertEqual(row["label"], "none")
        self.assertEqual(row["target"], "none")
        self.assertEqual(row["source_group"], "blind-hard-negative")
        self.assertEqual(row["boundary_group"], "none_reviewed_hard_negative")
        self.assertIn("blind/a", row["source_blind_id"])

    def test_build_report_blocks_when_no_accepted_rows(self) -> None:
        report = module.build_report([], candidates=2)

        self.assertEqual(report["accepted"], 0)
        self.assertIn("no accepted hard-negative candidates", report["failures"])
        self.assertEqual(report["decision"], "needs_human_acceptance")

    def test_build_report_ready_when_accepted_rows_exist(self) -> None:
        report = module.build_report([{"label": "none"}], candidates=2)

        self.assertEqual(report["accepted"], 1)
        self.assertEqual(report["decision"], "ready_to_append_fixtures")

    def test_write_jsonl_writes_empty_file_for_no_rows(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "empty.jsonl"

            module.write_jsonl(str(path), [])

            self.assertEqual(path.read_text(), "")


if __name__ == "__main__":
    unittest.main()
