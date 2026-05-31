#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_review_packet.py")
spec = importlib.util.spec_from_file_location("session_section_blind_review_packet", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_review_packet"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindReviewPacketTest(unittest.TestCase):
    def test_packet_item_merges_review_suggestion_priority_and_hard_negative(self) -> None:
        review = {"id": "blind/a", "label": "__pending__", "target": "__pending__", "text": "USER:\nwhat's next?"}
        suggestion = {"id": "blind/a", "suggested_label": "environment_or_preference_signal", "suggested_target": "workflow_state"}
        priority = {"id": "blind/a", "priority_score": 9, "risk_reasons": ["possible_none_control_turn"]}
        hard_negative = {
            "source_blind_id": "blind/a",
            "id": "pending-hard-negative/blind/a",
            "status": "pending_human_acceptance",
            "review_notes": "Needs a human decision.",
            "proposed_label": "none",
            "proposed_target": "none",
            "review_instruction": "Accept only if this is ordinary control flow.",
        }

        item = module.packet_item(review, suggestion, priority, hard_negative)

        self.assertEqual(item["id"], "blind/a")
        self.assertEqual(item["suggested_label"], "environment_or_preference_signal")
        self.assertEqual(item["priority_score"], 9)
        self.assertEqual(item["hard_negative_status"], "pending_human_acceptance")
        self.assertEqual(item["hard_negative_review_notes"], "Needs a human decision.")
        self.assertEqual(item["hard_negative_proposed_label"], "none")
        self.assertEqual(item["hard_negative_review_instruction"], "Accept only if this is ordinary control flow.")

    def test_build_packet_sorts_by_priority_descending(self) -> None:
        review = {"items": [{"id": "low", "text": ""}, {"id": "high", "text": ""}]}
        suggestions = {"items": []}
        priorities = {"items": [{"id": "high", "priority_score": 10}, {"id": "low", "priority_score": 1}]}
        hard_negatives = {"items": []}

        packet = module.build_packet(review, suggestions, priorities, hard_negatives)

        self.assertEqual([item["id"] for item in packet["items"]], ["high", "low"])

    def test_build_report_counts_pending_and_hard_negative_candidates(self) -> None:
        packet = {
            "items": [
                {"label": "__pending__", "hard_negative_status": "pending_human_acceptance"},
                {"label": "none", "hard_negative_status": None},
            ]
        }

        report = module.build_report(packet)

        self.assertEqual(report["items"], 2)
        self.assertEqual(report["pending_labels"], 1)
        self.assertEqual(report["hard_negative_candidates"], 1)
        self.assertEqual(report["decision"], "ready_for_consolidated_review")

    def test_render_markdown_includes_hard_negative_review_instruction(self) -> None:
        packet = {
            "instructions": "review context",
            "items": [{
                "id": "blind/a",
                "priority_score": 9,
                "risk_reasons": ["possible_none_control_turn"],
                "label": "__pending__",
                "target": "__pending__",
                "suggested_label": "environment_or_preference_signal",
                "suggested_target": "workflow_state",
                "confidence_bucket": "medium",
                "binary_confidence": 0.9,
                "family_confidence": 0.7,
                "hard_negative_status": "pending_human_acceptance",
                "hard_negative_review_notes": "This is ordinary control flow.",
                "hard_negative_proposed_label": "none",
                "hard_negative_proposed_target": "none",
                "hard_negative_review_instruction": "Accept if this should be a hard none example.",
                "hard_negative_candidate_id": "pending-hard-negative/blind/a",
                "source_window_id": "event_window:a",
                "source_turn": "turn:a",
                "source_session": "session:a",
                "source_seq": 1,
                "approx_tokens": 10,
                "evidence_refs": [],
                "text": "USER:\nwhat next?",
            }],
        }

        markdown = module.render_markdown(packet, 1)

        self.assertIn("- Hard-negative proposed label/target: `none` / `none`", markdown)
        self.assertIn("- Hard-negative notes: This is ordinary control flow.", markdown)
        self.assertIn("- Hard-negative review instruction: Accept if this should be a hard none example.", markdown)


if __name__ == "__main__":
    unittest.main()
