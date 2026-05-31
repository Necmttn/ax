import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("embedding_helper_review_batch.py")
spec = importlib.util.spec_from_file_location("session_section_embedding_helper_review_batch", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_embedding_helper_review_batch"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def review() -> dict:
    return {
        "schema": "ax.embedding_helper_review.v1",
        "decision": "ready_for_helper_review",
        "hard_negative_candidates": [{
            "id": "embedding-hard-negative/session-section-chunks/none-a",
            "source_fixture_id": "session-section-chunks/none-a",
            "status": "pending_human_acceptance",
            "proposed_label": "none",
            "review_instruction": "Accept only if this stays none.",
            "seen_in_seeds": [7],
            "predicted_label_counts": {"approval": 1},
            "max_confidence": 0.35,
            "max_margin": 0.18,
            "max_nearest_positive_similarity": 0.87,
            "nearest_neighbors": [{"id": "session-section-chunks/approval-a", "label": "approval", "similarity": 0.86}],
        }],
        "dedupe_clusters": [{
            "id": "embedding-dedupe-cluster/1",
            "status": "pending_review",
            "source_fixture_ids": ["session-section-chunks/correction-a", "session-section-chunks/correction-b"],
            "labels": {"correction_or_rejection_signal": 2},
            "review_instruction": "Count once?",
        }],
    }


def fixtures() -> dict:
    return {
        "session-section-chunks/none-a": {
            "id": "session-section-chunks/none-a",
            "label": "none",
            "target": "workflow_state",
            "text": "USER:\nwhat is next?",
        },
        "session-section-chunks/correction-a": {
            "id": "session-section-chunks/correction-a",
            "label": "correction_or_rejection_signal",
            "target": "wrong_output",
            "text": "USER:\nthat was not what I asked",
        },
        "session-section-chunks/correction-b": {
            "id": "session-section-chunks/correction-b",
            "label": "correction_or_rejection_signal",
            "target": "wrong_output",
            "text": "USER:\nnot the thing I requested",
        },
    }


class EmbeddingHelperReviewBatchTest(unittest.TestCase):
    def test_render_batch_includes_source_text_and_neighbor_evidence(self) -> None:
        markdown, report = module.render_batch(review(), fixtures(), 2)

        self.assertEqual(report["decision"], "embedding_helper_review_batch_ready")
        self.assertEqual(report["selected_hard_negatives"], 1)
        self.assertEqual(report["selected_dedupe_clusters"], 1)
        self.assertIn("- Candidate id: `embedding-hard-negative/session-section-chunks/none-a`", markdown)
        self.assertIn("USER:\nwhat is next?", markdown)
        self.assertIn("`session-section-chunks/approval-a`/approval@0.86", markdown)
        self.assertIn("- Cluster id: `embedding-dedupe-cluster/1`", markdown)
        self.assertIn("USER:\nnot the thing I requested", markdown)

    def test_select_batch_prefers_pending_hard_negatives_before_dedupe(self) -> None:
        hard, dedupe = module.select_batch(review(), 1)

        self.assertEqual(len(hard), 1)
        self.assertEqual(len(dedupe), 0)

    def test_sync_batch_updates_review_and_reports_remaining_pending_items(self) -> None:
        batch = """
## 1. Hard negative: session-section-chunks/none-a

- Candidate id: `embedding-hard-negative/session-section-chunks/none-a`
- Status: `accepted`
- Review notes: ordinary control request

## 2. Dedupe cluster: embedding-dedupe-cluster/1

- Cluster id: `embedding-dedupe-cluster/1`
- Status: `rejected`
- Review notes: different correction examples
"""

        synced, report = module.sync_batch(review(), batch)

        self.assertEqual(synced["hard_negative_candidates"][0]["status"], "accepted")
        self.assertEqual(synced["dedupe_clusters"][0]["status"], "rejected")
        self.assertEqual(report["dry_run"], False)
        self.assertEqual(report["would_write_review"], True)
        self.assertEqual(report["would_write_canonical_review"], True)
        self.assertEqual(report["wrote_review_out"], False)
        self.assertEqual(report["decision"], "ready_for_embedding_helper_export")
        self.assertEqual(report["hard_negative_pending"], 0)
        self.assertEqual(report["dedupe_pending"], 0)

    def test_sync_batch_dry_run_reports_without_changing_write_intent(self) -> None:
        synced, report = module.sync_batch(
            review(),
            """
- Candidate id: `embedding-hard-negative/session-section-chunks/none-a`
- Status: `accepted`
- Review notes: ordinary control request
""",
            dry_run=True,
        )

        self.assertEqual(synced["hard_negative_candidates"][0]["status"], "accepted")
        self.assertEqual(report["dry_run"], True)
        self.assertEqual(report["would_write_review"], False)
        self.assertEqual(report["would_write_canonical_review"], False)
        self.assertEqual(report["wrote_review_out"], False)

    def test_evaluate_batch_reports_progress_and_selected_batch_ids(self) -> None:
        report = module.evaluate_batch(
            review(),
            """
- Candidate id: `embedding-hard-negative/session-section-chunks/none-a`
- Status: `pending_human_acceptance`
- Review notes: _pending_
""",
        )

        self.assertEqual(report["decision"], "needs_embedding_helper_review")
        self.assertEqual(report["hard_negative_pending"], 1)
        self.assertEqual(report["dedupe_pending"], 1)
        self.assertEqual(report["selected_batch_items"], 1)
        self.assertEqual(report["selected_batch_ids"], ["embedding-hard-negative/session-section-chunks/none-a"])
        self.assertEqual(report["next_action"], "review pending embedding-helper hard negatives")


if __name__ == "__main__":
    unittest.main()
