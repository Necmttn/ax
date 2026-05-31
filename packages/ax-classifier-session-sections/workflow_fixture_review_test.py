#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_fixture_review.py")
spec = importlib.util.spec_from_file_location("session_section_workflow_fixture_review", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_workflow_fixture_review"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def fixture_row() -> dict:
    return {
        "id": "workflow-candidate-topic/surrealml/direction/abc123",
        "label": "direction",
        "target": "output_expectation",
        "text": "USER:\nshow me the classifier results\n\nPREVIOUS_ASSISTANT:\n",
        "review_status": "pending",
        "topic": "SurrealML",
        "candidate_id": "candidate:direction",
        "candidate_label": "direction-event:direction:output_expectation",
        "result_id": "classifier_result:direction",
        "turn": "turn:direction",
        "confidence": 0.82,
    }


class WorkflowFixtureReviewTest(unittest.TestCase):
    def test_generate_review_preserves_candidate_context(self) -> None:
        review = module.generate_review([fixture_row()])

        self.assertEqual(review["schema"], "ax.workflow_fixture_review.v1")
        self.assertEqual(review["items"][0]["id"], "workflow-candidate-topic/surrealml/direction/abc123")
        self.assertEqual(review["items"][0]["status"], "pending")
        self.assertEqual(review["items"][0]["label"], "direction")
        self.assertEqual(review["items"][0]["candidate_id"], "candidate:direction")

    def test_sync_review_updates_status_and_notes(self) -> None:
        review = module.generate_review([fixture_row()])
        brief = module.render_markdown_brief(review).replace(
            "- Status: `pending`\n- Label: `direction`\n- Target: `output_expectation`\n- Review notes: _pending_",
            "- Status: `accepted`\n- Label: `direction`\n- Target: `output_expectation`\n- Review notes: Good SurrealML output expectation fixture.",
        )

        synced = module.sync_review_from_markdown(review, brief)

        self.assertEqual(synced["items"][0]["status"], "accepted")
        self.assertEqual(synced["items"][0]["review_notes"], "Good SurrealML output expectation fixture.")

    def test_evaluate_review_blocks_pending_and_invalid_status(self) -> None:
        review = {
            "items": [
                {"id": "a", "status": "pending", "label": "direction", "review_notes": ""},
                {"id": "b", "status": "maybe", "label": "direction", "review_notes": "reviewed fixture"},
            ]
        }

        report = module.evaluate_review(review)

        self.assertEqual(report["pending"], 1)
        self.assertEqual(report["invalid_status_items"], ["b"])
        self.assertIn("workflow fixture review still has pending items", report["failures"])
        self.assertIn("workflow fixture review contains invalid statuses", report["failures"])
        self.assertEqual(report["decision"], "needs_workflow_fixture_review")

    def test_evaluate_review_blocks_missing_or_weak_notes(self) -> None:
        review = {
            "items": [
                {"id": "a", "status": "accepted", "label": "direction", "review_notes": ""},
                {"id": "b", "status": "rejected", "label": "direction", "review_notes": "ok"},
            ]
        }

        report = module.evaluate_review(review)

        self.assertEqual(report["reviewed_missing_notes"], ["a"])
        self.assertEqual(report["reviewed_invalid_notes"], ["b"])
        self.assertEqual(report["decision"], "needs_workflow_fixture_review")

    def test_apply_review_outputs_only_accepted_rows(self) -> None:
        rows = [fixture_row(), {**fixture_row(), "id": "workflow-candidate-topic/surrealml/direction/rejected"}]
        review = {
            "items": [
                {
                    "id": rows[0]["id"],
                    "status": "accepted",
                    "label": "direction",
                    "target": "output_expectation",
                    "review_notes": "Good SurrealML output expectation fixture.",
                },
                {
                    "id": rows[1]["id"],
                    "status": "rejected",
                    "label": "direction",
                    "target": "output_expectation",
                    "review_notes": "Duplicate of the accepted fixture.",
                },
            ]
        }

        accepted = module.apply_review_to_fixtures(rows, review)
        report = module.evaluate_review(review)

        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["id"], rows[0]["id"])
        self.assertEqual(accepted[0]["review_status"], "accepted")
        self.assertEqual(accepted[0]["review_notes"], "Good SurrealML output expectation fixture.")
        self.assertEqual(report["decision"], "ready_to_append_workflow_fixtures")


if __name__ == "__main__":
    unittest.main()
