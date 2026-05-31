#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_review_batch_refresh.py")
spec = importlib.util.spec_from_file_location("session_section_blind_review_batch_refresh", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_review_batch_refresh"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindReviewBatchRefreshTest(unittest.TestCase):
    def test_refresh_writes_coherent_batch_eval_sync_status_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace.md"
            workspace_report = root / "workspace-report.json"
            batch = root / "batch.md"
            batch_report = root / "batch-report.json"
            batch_eval = root / "batch-eval.json"
            batch_sync = root / "batch-sync.json"
            workspace_out = root / "workspace-preview.md"
            status = root / "status.json"
            summary = root / "summary.json"
            workspace.write_text(
                "# Workspace\n\n"
                "## 1. blind/a\n\n"
                "- Review label: `__pending__`\n"
                "- Review target: `__pending__`\n"
                "- Review notes: _pending_\n"
                "- Hard-negative candidate id: `_none_`\n"
                "- Hard-negative status: `_none_`\n"
                "- Hard-negative notes: _pending_\n"
            )
            workspace_report.write_text(
                json.dumps(
                    {
                        "decision": "needs_human_review",
                        "progress": {"blind_label_next_pending_refs": [{"ordinal": 1, "id": "blind/a"}]},
                    }
                )
            )
            paths = {
                "blind_label_review": root / "blind-label.json",
                "blind_roundtrip": root / "roundtrip.json",
                "suggestions": root / "suggestions.json",
                "priority": root / "priority.json",
                "sensitivity": root / "sensitivity.json",
                "hard_negatives": root / "hard-negatives.json",
                "hard_negative_export": root / "hard-export.json",
                "hard_negative_review": root / "hard-review.json",
                "strict_none_gate": root / "strict-none.json",
                "review_packet": root / "packet.json",
                "post_review": root / "post-review.json",
            }
            for path in paths.values():
                path.write_text(json.dumps({"decision": "ready_for_human_acceptance"}))
            paths["blind_label_review"].write_text(json.dumps({"decision": "needs_blind_label_review", "pending": 1}))
            paths["hard_negative_review"].write_text(json.dumps({"decision": "ready_for_hard_negative_export", "pending": 0}))

            args = argparse.Namespace(
                workspace=str(workspace),
                workspace_report=str(workspace_report),
                batch=str(batch),
                batch_report=str(batch_report),
                batch_eval=str(batch_eval),
                batch_sync=str(batch_sync),
                workspace_out=str(workspace_out),
                status=str(status),
                summary=str(summary),
                limit=5,
                allow_incomplete=False,
                dry_run=False,
                **{key: str(path) for key, path in paths.items()},
            )

            report = module.refresh(args)

            self.assertEqual(report["decision"], "refreshed")
            self.assertEqual(report["batch_source"], "regenerated_from_workspace")
            self.assertEqual(report["batch_eval_decision"], "needs_batch_review")
            self.assertEqual(report["batch_sync_decision"], "needs_batch_review")
            self.assertEqual(report["artifact_consistency_decision"], "consistent")
            self.assertFalse(workspace_out.exists())
            self.assertTrue(batch.exists())
            self.assertIn("Review workload:", batch.read_text())
            self.assertIn("Field completion: `0` / `3` (0.0%)", batch.read_text())
            self.assertIn("Blocking fields: `3`", batch.read_text())
            self.assertIn("Missing fields: Review label: 1, Review notes: 1, Review target: 1", batch.read_text())
            self.assertIn("Post-edit commands:", batch.read_text())
            self.assertIn("bun run classifiers:blind-review-batch -- --mode=evaluate", batch.read_text())
            self.assertIn("Review label guidance:", batch.read_text())
            self.assertIn("Hard-negative status guidance:", batch.read_text())
            self.assertTrue(status.exists())
            status_json = json.loads(status.read_text())
            self.assertEqual(status_json["artifact_consistency"]["decision"], "consistent")
            self.assertEqual(
                status_json["stages"]["review_batch_eval"]["details"]["batch_sha256"],
                status_json["stages"]["review_batch_sync"]["details"]["batch_sha256"],
            )

    def test_refresh_preserves_existing_reviewed_batch_instead_of_regenerating_from_stale_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / "workspace.md"
            workspace_report = root / "workspace-report.json"
            batch = root / "batch.md"
            batch_report = root / "batch-report.json"
            batch_eval = root / "batch-eval.json"
            batch_sync = root / "batch-sync.json"
            workspace_out = root / "workspace-preview.md"
            status = root / "status.json"
            summary = root / "summary.json"
            workspace.write_text(
                "# Workspace\n\n"
                "## 1. blind/a\n\n"
                "- Review label: `__pending__`\n"
                "- Review target: `__pending__`\n"
                "- Review notes: _pending_\n"
                "- Hard-negative candidate id: `_none_`\n"
                "- Hard-negative status: `_none_`\n"
                "- Hard-negative notes: _pending_\n"
            )
            workspace_report.write_text(
                json.dumps(
                    {
                        "decision": "needs_human_review",
                        "progress": {"blind_label_next_pending_refs": [{"ordinal": 1, "id": "blind/a"}]},
                    }
                )
            )
            batch.write_text(
                "# Batch\n\n"
                "## 1. blind/a\n\n"
                "- Review label: `none`\n"
                "- Review target: `none`\n"
                "- Review notes: Reviewed as ordinary control context.\n"
                "- Hard-negative candidate id: `_none_`\n"
                "- Hard-negative status: `_none_`\n"
                "- Hard-negative notes: _pending_\n"
            )
            batch_report.write_text(json.dumps({"decision": "ready_for_batch_review", "failures": []}))
            paths = {
                "blind_label_review": root / "blind-label.json",
                "blind_roundtrip": root / "roundtrip.json",
                "suggestions": root / "suggestions.json",
                "priority": root / "priority.json",
                "sensitivity": root / "sensitivity.json",
                "hard_negatives": root / "hard-negatives.json",
                "hard_negative_export": root / "hard-export.json",
                "hard_negative_review": root / "hard-review.json",
                "strict_none_gate": root / "strict-none.json",
                "review_packet": root / "packet.json",
                "post_review": root / "post-review.json",
            }
            for path in paths.values():
                path.write_text(json.dumps({"decision": "ready_for_human_acceptance"}))
            paths["blind_label_review"].write_text(json.dumps({"decision": "needs_blind_label_review", "pending": 1}))
            paths["hard_negative_review"].write_text(json.dumps({"decision": "ready_for_hard_negative_export", "pending": 0}))

            args = argparse.Namespace(
                workspace=str(workspace),
                workspace_report=str(workspace_report),
                batch=str(batch),
                batch_report=str(batch_report),
                batch_eval=str(batch_eval),
                batch_sync=str(batch_sync),
                workspace_out=str(workspace_out),
                status=str(status),
                summary=str(summary),
                limit=5,
                allow_incomplete=False,
                dry_run=True,
                **{key: str(path) for key, path in paths.items()},
            )

            report = module.refresh(args)

            self.assertEqual(report["batch_source"], "existing_reviewed_batch")
            self.assertEqual(report["batch_eval_decision"], "ready_for_batch_sync")
            self.assertEqual(report["batch_sync_decision"], "ready_for_workspace_dry_run")
            self.assertIn("- Review label: `none`", batch.read_text())
            self.assertNotIn("- Review label: `__pending__`", batch.read_text())
            self.assertEqual(json.loads(batch_eval.read_text())["decision"], "ready_for_batch_sync")


if __name__ == "__main__":
    unittest.main()
