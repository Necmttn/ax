import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("boundary_miss_review.py")
spec = importlib.util.spec_from_file_location("session_section_boundary_miss_review", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_boundary_miss_review"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def analysis() -> dict:
    return {
        "decision": "robust_with_residual_none_false_positive_review",
        "gate": {"passed": True},
        "all_seed_repeated_misses": [
            {
                "id": "session-section-chunks/correction-dirty-files-question",
                "actual": "correction_or_rejection_signal",
                "predicted_labels": ["verification_or_recovery_signal"],
                "families": ["label_boundary"],
                "seeds": [7, 13, 42],
                "hit_count": 3,
                "max_confidence": 0.86,
                "fine_label": "correction",
                "target": "workflow_state",
                "source_group": "session-section-chunks",
                "boundary_group": "workflow_state",
                "pair_group": "workflow_state::correction",
                "text_excerpt": "USER: is there still any dirty files left?",
            },
            {
                "id": "embedding-helper-hard-negative/session-section-chunks/none-task-recall",
                "actual": "none",
                "predicted_labels": ["none"],
                "families": [],
                "seeds": [7, 13],
                "hit_count": 2,
                "max_confidence": 0.91,
                "fine_label": "none",
                "target": "none",
                "source_group": "embedding-helper-hard-negative",
                "boundary_group": "none_task_recall",
                "pair_group": "none_task_recall::none",
                "text_excerpt": "USER: what was the task?",
            },
        ],
    }


class BoundaryMissReviewTest(unittest.TestCase):
    def test_generate_review_filters_to_canonical_repeated_misses(self) -> None:
        review = module.generate_review(analysis(), min_hit_count=2, source_group="session-section-chunks")

        self.assertEqual(review["schema"], "ax.boundary_miss_review.v1")
        self.assertEqual(len(review["items"]), 1)
        self.assertEqual(review["items"][0]["id"], "session-section-chunks/correction-dirty-files-question")
        self.assertEqual(review["items"][0]["review_label"], "correction")
        self.assertEqual(review["items"][0]["status"], "pending")

    def test_sync_review_updates_status_label_action_and_notes(self) -> None:
        review = module.generate_review(analysis())
        brief = module.render_markdown_brief(review).replace(
            "- Status: `pending`\n- Review label: `correction`\n- Review action: `keep_existing_label`\n- Review notes: _pending_",
            "- Status: `accepted`\n- Review label: `correction`\n- Review action: `keep_existing_label`\n- Review notes: Current correction label is correct; this is a git hygiene correction.",
        )

        synced = module.sync_review_from_markdown(review, brief)

        self.assertEqual(synced["items"][0]["status"], "accepted")
        self.assertEqual(synced["items"][0]["review_action"], "keep_existing_label")
        self.assertIn("git hygiene", synced["items"][0]["review_notes"])

    def test_evaluate_review_blocks_pending_and_invalid_rows(self) -> None:
        report = module.evaluate_review({
            "items": [
                {"id": "pending", "status": "pending", "review_label": "correction", "review_notes": ""},
                {"id": "invalid", "status": "maybe", "review_label": "correction", "review_notes": "Needs a real review note."},
                {"id": "bad-label", "status": "accepted", "review_label": "wrong", "current_label": "correction", "review_notes": "Current label is correct."},
            ]
        })

        self.assertEqual(report["decision"], "needs_boundary_miss_review")
        self.assertIn("boundary miss review still has pending items", report["failures"])
        self.assertEqual(report["invalid_status_items"], ["invalid"])
        self.assertEqual(report["invalid_label_items"], ["bad-label"])

    def test_evaluate_review_rejects_accepted_label_changes(self) -> None:
        report = module.evaluate_review({
            "items": [
                {
                    "id": "changed",
                    "status": "accepted",
                    "review_label": "verification_request",
                    "current_label": "correction",
                    "review_notes": "Changing this would require a separate fixture edit.",
                }
            ]
        })

        self.assertEqual(report["accepted_label_change_items"], ["changed"])
        self.assertIn("accepted boundary misses cannot change labels", report["failures"])

    def test_evaluate_review_distinguishes_ready_from_required_changes(self) -> None:
        ready = module.evaluate_review({
            "items": [
                {
                    "id": "accepted",
                    "status": "accepted",
                    "review_label": "correction",
                    "current_label": "correction",
                    "actual": "correction_or_rejection_signal",
                    "families": ["label_boundary"],
                    "review_notes": "Current correction label is correct for git hygiene.",
                }
            ]
        })
        rejected = module.evaluate_review({
            "items": [
                {
                    "id": "rejected",
                    "status": "rejected",
                    "review_label": "correction",
                    "current_label": "correction",
                    "actual": "correction_or_rejection_signal",
                    "families": ["label_boundary"],
                    "review_notes": "Needs fixture text adjustment before promotion.",
                }
            ]
        })

        self.assertEqual(ready["decision"], "boundary_review_ready_for_fixture_promotion")
        self.assertTrue(ready["promotion_ready"])
        self.assertEqual(rejected["decision"], "boundary_review_requires_fixture_changes")
        self.assertFalse(rejected["promotion_ready"])


if __name__ == "__main__":
    unittest.main()
