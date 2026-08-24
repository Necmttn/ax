import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("embedding_helper_export.py")
spec = importlib.util.spec_from_file_location("session_section_embedding_helper_export", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_embedding_helper_export"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def review() -> dict:
    return {
        "schema": "ax.embedding_helper_review.v1",
        "decision": "ready_for_helper_review",
        "hard_negative_candidates": [{
            "id": "embedding-hard-negative/session-section-chunks/none-a",
            "source_fixture_id": "session-section-chunks/none-a",
            "status": "accepted",
            "review_notes": "ordinary control request that should stay none",
            "seen_in_seeds": [7, 13],
            "predicted_label_counts": {"direction": 2},
            "max_confidence": 0.91,
            "max_margin": 0.22,
            "max_nearest_positive_similarity": 0.87,
            "nearest_neighbors": [{"id": "session-section-chunks/direction-a", "label": "direction", "similarity": 0.87}],
        }],
        "dedupe_clusters": [{
            "id": "embedding-dedupe-cluster/1",
            "status": "accepted",
            "source_fixture_ids": ["session-section-chunks/correction-a", "session-section-chunks/correction-b"],
            "labels": {"correction": 2},
            "review_notes": "same correction evidence phrased twice",
        }],
    }


class EmbeddingHelperExportTest(unittest.TestCase):
    def test_export_blocks_when_review_status_is_pending(self) -> None:
        rows, hints, report = module.export_review(
            review(),
            {"decision": "needs_embedding_helper_review"},
            {"session-section-chunks/none-a": {"id": "session-section-chunks/none-a", "label": "none", "text": "USER:\nstatus?"}},
        )

        self.assertEqual(rows, [])
        self.assertEqual(hints["cluster_count"], 0)
        self.assertEqual(report["decision"], "needs_embedding_helper_review")
        self.assertIn("embedding helper review is not ready for export", report["failures"])

    def test_export_accepted_hard_negatives_as_append_ready_none_rows(self) -> None:
        rows, hints, report = module.export_review(
            review(),
            {"decision": "ready_for_embedding_helper_export"},
            {"session-section-chunks/none-a": {"id": "session-section-chunks/none-a", "label": "direction", "text": "USER:\nwhat next?"}},
        )

        self.assertEqual(report["decision"], "ready_to_append_embedding_helper_fixtures")
        self.assertEqual(report["exported_fixture_rows"], 1)
        self.assertEqual(rows[0]["label"], "none")
        self.assertEqual(rows[0]["target"], "none")
        self.assertEqual(rows[0]["text"], "USER:\nwhat next?")
        self.assertEqual(rows[0]["source_group"], "embedding-helper-hard-negative")
        self.assertEqual(rows[0]["source_original_label"], "direction")
        self.assertEqual(rows[0]["nearest_neighbors"][0]["label"], "direction")
        self.assertEqual(hints["cluster_count"], 1)
        self.assertEqual(hints["clusters"][0]["hint"], "count_as_single_evidence_cluster")

    def test_export_reports_missing_accepted_source_fixtures(self) -> None:
        rows, _hints, report = module.export_review(
            review(),
            {"decision": "ready_for_embedding_helper_export"},
            {},
        )

        self.assertEqual(rows, [])
        self.assertEqual(report["decision"], "needs_embedding_helper_review")
        self.assertEqual(report["missing_fixtures"], ["session-section-chunks/none-a"])

    def test_export_partial_preview_emits_non_appendable_rows_while_review_pending(self) -> None:
        rows, hints, report = module.export_review(
            review(),
            {"decision": "needs_embedding_helper_review"},
            {"session-section-chunks/none-a": {"id": "session-section-chunks/none-a", "label": "none", "text": "USER:\nstatus?"}},
            allow_partial_preview=True,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(hints["cluster_count"], 1)
        self.assertEqual(report["decision"], "partial_embedding_helper_export_preview")
        self.assertEqual(report["partial_preview"], True)
        self.assertEqual(report["appendable"], False)
        self.assertIn("embedding helper review is not ready for export", report["failures"])

    def test_partial_preview_decision_remains_non_appendable_even_when_callers_exit_zero(self) -> None:
        _rows, _hints, report = module.export_review(
            review(),
            {"decision": "needs_embedding_helper_review"},
            {"session-section-chunks/none-a": {"id": "session-section-chunks/none-a", "label": "none", "text": "USER:\nstatus?"}},
            allow_partial_preview=True,
        )

        self.assertEqual(report["decision"], "partial_embedding_helper_export_preview")
        self.assertEqual(report["appendable"], False)


if __name__ == "__main__":
    unittest.main()
