import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("embedding_helper_review_status.py")
spec = importlib.util.spec_from_file_location("session_section_embedding_helper_review_status", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_embedding_helper_review_status"] = module
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
            "review_notes": "",
        }],
        "dedupe_clusters": [{
            "id": "embedding-dedupe-cluster/1",
            "status": "pending_review",
            "review_notes": "",
        }],
    }


class EmbeddingHelperReviewStatusTest(unittest.TestCase):
    def test_parse_markdown_review_updates_hard_negative_and_dedupe_statuses(self) -> None:
        brief = """
### 1. session-section-chunks/none-a

- Candidate id: `embedding-hard-negative/session-section-chunks/none-a`
- Status: `accepted`
- Review notes: ordinary control request

### embedding-dedupe-cluster/1

- Cluster id: `embedding-dedupe-cluster/1`
- Status: `rejected`
- Review notes: distinct correction cases
"""

        updates = module.parse_markdown_review(brief)

        self.assertEqual(updates["embedding-hard-negative/session-section-chunks/none-a"]["status"], "accepted")
        self.assertEqual(updates["embedding-hard-negative/session-section-chunks/none-a"]["review_notes"], "ordinary control request")
        self.assertEqual(updates["embedding-dedupe-cluster/1"]["status"], "rejected")
        self.assertEqual(updates["embedding-dedupe-cluster/1"]["review_notes"], "distinct correction cases")

    def test_sync_review_from_markdown_updates_known_review_items(self) -> None:
        brief = """
- Candidate id: `embedding-hard-negative/session-section-chunks/none-a`
- Status: `rejected`
- Review notes: actually carries direction
- Cluster id: `embedding-dedupe-cluster/1`
- Status: `accepted`
- Review notes: same evidence repeated
"""

        synced = module.sync_review_from_markdown(review(), brief)

        self.assertEqual(synced["hard_negative_candidates"][0]["status"], "rejected")
        self.assertEqual(synced["hard_negative_candidates"][0]["review_notes"], "actually carries direction")
        self.assertEqual(synced["dedupe_clusters"][0]["status"], "accepted")
        self.assertEqual(synced["dedupe_clusters"][0]["review_notes"], "same evidence repeated")

    def test_evaluate_review_blocks_pending_items(self) -> None:
        report = module.evaluate_review(review())

        self.assertEqual(report["hard_negative_pending"], 1)
        self.assertEqual(report["dedupe_pending"], 1)
        self.assertEqual(report["decision"], "needs_embedding_helper_review")
        self.assertIn("embedding helper hard-negative review still has pending candidates", report["failures"])
        self.assertIn("embedding helper dedupe review still has pending clusters", report["failures"])

    def test_evaluate_review_requires_substantive_notes_for_reviewed_items(self) -> None:
        record = review()
        record["hard_negative_candidates"][0]["status"] = "accepted"
        record["hard_negative_candidates"][0]["review_notes"] = "ok"
        record["dedupe_clusters"][0]["status"] = "rejected"
        record["dedupe_clusters"][0]["review_notes"] = ""

        report = module.evaluate_review(record)

        self.assertEqual(report["hard_negative_invalid_notes"], ["embedding-hard-negative/session-section-chunks/none-a"])
        self.assertEqual(report["dedupe_missing_notes"], ["embedding-dedupe-cluster/1"])
        self.assertEqual(report["decision"], "needs_embedding_helper_review")

    def test_evaluate_review_ready_when_all_items_reviewed_with_notes(self) -> None:
        record = review()
        record["hard_negative_candidates"][0]["status"] = "accepted"
        record["hard_negative_candidates"][0]["review_notes"] = "ordinary control"
        record["dedupe_clusters"][0]["status"] = "rejected"
        record["dedupe_clusters"][0]["review_notes"] = "different failures"

        report = module.evaluate_review(record)

        self.assertEqual(report["hard_negative_pending"], 0)
        self.assertEqual(report["dedupe_pending"], 0)
        self.assertEqual(report["decision"], "ready_for_embedding_helper_export")


if __name__ == "__main__":
    unittest.main()
