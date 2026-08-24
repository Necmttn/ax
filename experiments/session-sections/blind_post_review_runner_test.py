#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
from types import SimpleNamespace
import sys
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).with_name("blind_post_review_runner.py")
spec = importlib.util.spec_from_file_location("session_section_blind_post_review_runner", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_post_review_runner"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindPostReviewRunnerTest(unittest.TestCase):
    def test_build_report_blocks_when_workspace_not_ready(self) -> None:
        report = module.build_report(
            {"workspace": {"decision": "needs_human_review"}},
            ["blind_roundtrip", "hard_negative_export"],
        )

        self.assertEqual(report["decision"], "needs_human_review")
        self.assertIn("workspace is not ready for post-review run", report["failures"])
        self.assertIn("blind_roundtrip", report["skipped"])

    def test_build_report_surfaces_gate_stack_failure(self) -> None:
        report = module.build_report(
            {
                "workspace": {"decision": "ready_for_roundtrip"},
                "blind_roundtrip": {"decision": "needs_gate_stack_work"},
            },
            ["fixture_append"],
        )

        self.assertEqual(report["decision"], "needs_gate_stack_work")
        self.assertIn("blind gate stack is not ready", report["failures"])

    def test_build_report_ready_after_all_stages_pass(self) -> None:
        report = module.build_report(
            {
                "workspace": {"decision": "ready_for_roundtrip"},
                "blind_roundtrip": {"decision": "candidate_blind_gate_stack"},
                "hard_negative_export": {"decision": "ready_to_append_fixtures"},
                "fixture_append": {"decision": "ready_to_write_combined_fixtures"},
            },
            [],
        )

        self.assertEqual(report["decision"], "ready_for_next_model_run")
        self.assertEqual(report["failures"], [])

    def test_load_or_sync_workspace_rejects_invalid_updates_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            review_path = root / "review.json"
            candidates_path = root / "candidates.json"
            workspace_path = root / "workspace.md"
            report_path = root / "workspace-report.json"
            review_path.write_text(
                '{"items":[{"id":"blind/a","label":"__pending__","target":"__pending__","review_notes":""}]}'
            )
            candidates_path.write_text(
                '{"items":[{"id":"pending-hard-negative/blind/a","status":"pending_human_acceptance","review_notes":""}]}'
            )
            workspace_path.write_text(
                """
## 1. blind/a

- Review label: `surprise`
- Review target: `none`
- Review notes: bad label should not write
- Hard-negative candidate id: `pending-hard-negative/blind/a`
- Hard-negative status: `accepted`
- Hard-negative notes: should not write
"""
            )
            args = SimpleNamespace(
                review=str(review_path),
                hard_negatives=str(candidates_path),
                workspace=str(workspace_path),
                workspace_report=str(report_path),
                sync_workspace=True,
            )

            _, _, report = module.load_or_sync_workspace(args)

            self.assertEqual(report["decision"], "needs_workspace_fix")
            self.assertIn("invalid review label for blind/a: surprise", report["workspace_update_failures"])
            self.assertIn('"label":"__pending__"', review_path.read_text())
            self.assertIn('"status":"pending_human_acceptance"', candidates_path.read_text())

    def test_run_pipeline_happy_path_writes_downstream_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            review_path = root / "review.json"
            candidates_path = root / "candidates.json"
            fixtures_path = root / "blind-fixtures.jsonl"
            predictions_path = root / "predictions.jsonl"
            base_path = root / "base.jsonl"
            labeled_path = root / "labeled.jsonl"
            eval_path = root / "eval.json"
            roundtrip_path = root / "roundtrip.json"
            append_path = root / "append.jsonl"
            append_report_path = root / "append-report.json"
            combined_path = root / "combined.jsonl"
            combined_report_path = root / "combined-report.json"
            workspace_report_path = root / "workspace-report.json"
            review_path.write_text(json.dumps({
                "items": [
                    {"id": "blind/none", "label": "none", "target": "none", "review_notes": "control turn"},
                    {"id": "blind/approval", "label": "approval", "target": "continue", "review_notes": "explicit approval"},
                ]
            }))
            candidates_path.write_text(json.dumps({
                "items": [
                    {
                        "id": "pending-hard-negative/blind/none",
                        "source_blind_id": "blind/none",
                        "status": "accepted",
                        "review_notes": "reviewed none boundary",
                        "text": "USER:\nwhat was the task?",
                        "risk_reasons": ["possible_none_control_turn"],
                    }
                ]
            }))
            fixtures_path.write_text(
                "\n".join([
                    json.dumps({"id": "blind/none", "label": "__pending__", "target": "__pending__", "text": "USER:\nplain status?"}),
                    json.dumps({"id": "blind/approval", "label": "__pending__", "target": "__pending__", "text": "USER:\nokay run it"}),
                ])
                + "\n"
            )
            predictions_path.write_text(
                "\n".join([
                    json.dumps({"id": "blind/none", "predicted": "none"}),
                    json.dumps({"id": "blind/approval", "predicted": "approval"}),
                ])
                + "\n"
            )
            base_path.write_text(json.dumps({"id": "session-section-chunks/base", "label": "none", "source_group": "base"}) + "\n")
            args = SimpleNamespace(
                workspace=str(root / "workspace.md"),
                sync_workspace=False,
                review=str(review_path),
                hard_negatives=str(candidates_path),
                fixtures=str(fixtures_path),
                predictions=str(predictions_path),
                base_fixtures=str(base_path),
                labeled_out=str(labeled_path),
                blind_eval_out=str(eval_path),
                blind_roundtrip_report=str(roundtrip_path),
                append_out=str(append_path),
                append_report=str(append_report_path),
                combined_out=str(combined_path),
                combined_report=str(combined_report_path),
                workspace_report=str(workspace_report_path),
            )

            report = module.run_pipeline(args)

            self.assertEqual(report["decision"], "ready_for_next_model_run")
            self.assertEqual(report["stages"]["blind_roundtrip"]["decision"], "candidate_blind_gate_stack")
            self.assertEqual(report["stages"]["hard_negative_export"]["decision"], "ready_to_append_fixtures")
            self.assertEqual(report["stages"]["fixture_append"]["decision"], "ready_to_write_combined_fixtures")
            self.assertTrue(labeled_path.exists())
            self.assertTrue(eval_path.exists())
            self.assertTrue(append_path.read_text().strip())
            self.assertEqual(len([line for line in combined_path.read_text().splitlines() if line.strip()]), 2)


if __name__ == "__main__":
    unittest.main()
