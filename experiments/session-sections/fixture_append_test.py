#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("fixture_append.py")
spec = importlib.util.spec_from_file_location("session_section_fixture_append", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_fixture_append"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class FixtureAppendTest(unittest.TestCase):
    def test_validate_append_rows_blocks_empty_append(self) -> None:
        failures = module.validate_append_rows(base_rows=[{"id": "a"}], append_rows=[])

        self.assertIn("no append rows supplied", failures)

    def test_validate_append_rows_blocks_duplicate_ids(self) -> None:
        failures = module.validate_append_rows(base_rows=[{"id": "a"}], append_rows=[{"id": "a", "label": "none"}])

        self.assertIn("append rows duplicate existing fixture ids: a", failures)

    def test_validate_append_rows_accepts_already_promoted_identical_rows_when_allowed(self) -> None:
        row = {
            "id": "session-section-chunks/embedding-helper-hard-negative-none-a",
            "label": "none",
            "target": "none",
            "source_group": "embedding-helper-hard-negative",
            "source_candidate_id": "embedding-hard-negative/session-section-chunks/none-a",
            "source_fixture_id": "session-section-chunks/none-a",
            "review_notes": "Reviewed as a none hard negative.",
        }

        failures = module.validate_append_rows(base_rows=[row], append_rows=[row], allow_existing_identical=True)

        self.assertEqual(failures, [])

    def test_validate_append_rows_blocks_existing_conflict_when_existing_rows_allowed(self) -> None:
        base = [{
            "id": "session-section-chunks/embedding-helper-hard-negative-none-a",
            "label": "none",
            "target": "none",
            "source_group": "embedding-helper-hard-negative",
            "source_candidate_id": "embedding-hard-negative/session-section-chunks/none-a",
            "source_fixture_id": "session-section-chunks/none-a",
            "review_notes": "Reviewed as a none hard negative.",
        }]
        append = [{**base[0], "review_notes": "Different review note."}]

        failures = module.validate_append_rows(base_rows=base, append_rows=append, allow_existing_identical=True)

        self.assertIn("append rows conflict with existing fixture ids: session-section-chunks/embedding-helper-hard-negative-none-a", failures)

    def test_validate_append_rows_blocks_non_none_labels(self) -> None:
        failures = module.validate_append_rows(base_rows=[], append_rows=[{"id": "b", "label": "direction"}])

        self.assertIn(
            "append rows must come from blind-hard-negative, embedding-helper-hard-negative, or workflow-candidate sources",
            failures,
        )

    def test_validate_append_rows_blocks_non_none_hard_negative_labels(self) -> None:
        failures = module.validate_append_rows(
            base_rows=[],
            append_rows=[{"id": "b", "label": "direction", "source_group": "blind-hard-negative"}],
        )

        self.assertIn("blind hard-negative append rows must keep label none", failures)

    def test_validate_append_rows_accepts_embedding_helper_hard_negatives(self) -> None:
        failures = module.validate_append_rows(
            base_rows=[],
            append_rows=[{
                "id": "session-section-chunks/embedding-helper-hard-negative-none-a",
                "label": "none",
                "target": "none",
                "source_group": "embedding-helper-hard-negative",
                "source_candidate_id": "embedding-hard-negative/session-section-chunks/none-a",
                "source_fixture_id": "session-section-chunks/none-a",
                "review_notes": "Reviewed as a none hard negative.",
            }],
        )

        self.assertEqual(failures, [])

    def test_validate_append_rows_blocks_incomplete_embedding_helper_rows(self) -> None:
        failures = module.validate_append_rows(
            base_rows=[],
            append_rows=[{
                "id": "session-section-chunks/embedding-helper-hard-negative-none-a",
                "label": "none",
                "source_group": "embedding-helper-hard-negative",
                "review_notes": "",
            }],
        )

        self.assertIn("embedding-helper hard-negative append rows must be accepted reviewed none fixtures", failures)

    def test_validate_append_rows_accepts_reviewed_workflow_fixtures(self) -> None:
        failures = module.validate_append_rows(
            base_rows=[],
            append_rows=[{
                "id": "workflow-candidate-topic/surrealml/direction/abc123",
                "label": "direction",
                "target": "output_expectation",
                "source_group": "workflow-candidate",
                "review_status": "accepted",
                "review_notes": "Good output expectation fixture.",
            }],
        )

        self.assertEqual(failures, [])

    def test_validate_append_rows_blocks_unreviewed_workflow_fixtures(self) -> None:
        failures = module.validate_append_rows(
            base_rows=[],
            append_rows=[{
                "id": "workflow-candidate-topic/surrealml/direction/abc123",
                "label": "direction",
                "source_group": "workflow-candidate",
                "review_status": "pending",
                "review_notes": "",
            }],
        )

        self.assertIn("workflow-candidate append rows must be accepted reviewed classifier fixtures", failures)

    def test_build_report_ready_for_valid_append(self) -> None:
        base = [{"id": "a"}]
        append = [{"id": "b", "label": "none", "source_group": "blind-hard-negative"}]

        report = module.build_report(base, append, [])

        self.assertEqual(report["base_rows"], 1)
        self.assertEqual(report["append_rows"], 1)
        self.assertEqual(report["combined_rows"], 2)
        self.assertEqual(report["decision"], "ready_to_write_combined_fixtures")

    def test_build_report_tracks_existing_identical_rows(self) -> None:
        row = {
            "id": "session-section-chunks/embedding-helper-hard-negative-none-a",
            "label": "none",
            "source_group": "embedding-helper-hard-negative",
            "source_candidate_id": "embedding-hard-negative/session-section-chunks/none-a",
            "source_fixture_id": "session-section-chunks/none-a",
            "review_notes": "Reviewed as a none hard negative.",
        }

        report = module.build_report([row], [row], [], allow_existing_identical=True)

        self.assertEqual(report["append_rows"], 1)
        self.assertEqual(report["new_append_rows"], 0)
        self.assertEqual(report["already_existing_rows"], 1)
        self.assertEqual(report["combined_rows"], 1)

    def test_combined_rows_preserve_order(self) -> None:
        combined = module.combined_rows([{"id": "a"}], [{"id": "b"}])

        self.assertEqual([row["id"] for row in combined], ["a", "b"])

    def test_combined_rows_skips_existing_identical_rows_when_allowed(self) -> None:
        row = {
            "id": "session-section-chunks/embedding-helper-hard-negative-none-a",
            "label": "none",
            "source_group": "embedding-helper-hard-negative",
            "source_candidate_id": "embedding-hard-negative/session-section-chunks/none-a",
            "source_fixture_id": "session-section-chunks/none-a",
            "review_notes": "Reviewed as a none hard negative.",
        }

        combined = module.combined_rows([row], [row], allow_existing_identical=True)

        self.assertEqual(combined, [row])


if __name__ == "__main__":
    unittest.main()
