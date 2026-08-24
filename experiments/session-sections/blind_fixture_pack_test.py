import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("blind_fixture_pack.py")
spec = importlib.util.spec_from_file_location("session_section_blind_fixture_pack", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_blind_fixture_pack"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class BlindFixturePackTest(unittest.TestCase):
    def test_candidate_rows_drop_light_labels_and_use_pending_labels(self) -> None:
        windows = [
            {
                "id": "event_window:a",
                "turn": "turn:a",
                "session": "session:s1",
                "seq": 4,
                "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was midway through work.",
                "approx_tokens": 8,
                "light_labels": ["approval"],
                "light_results": [{"label": "approval"}],
                "evidence": [{"kind": "previous_assistant", "ref": "turn:p"}],
            }
        ]

        rows = module.build_blind_rows(windows, limit=1, seed=7)

        self.assertEqual(rows, [
            {
                "id": "blind-session-sections/a",
                "source_window_id": "event_window:a",
                "source_turn": "turn:a",
                "source_session": "session:s1",
                "source_seq": 4,
                "label": "__pending__",
                "target": "__pending__",
                "text": "USER:\ncontinue\n\nPREVIOUS_ASSISTANT:\nI was midway through work.",
                "approx_tokens": 8,
                "evidence": [{"kind": "previous_assistant", "ref": "turn:p"}],
                "review_notes": "",
            }
        ])
        self.assertNotIn("light_labels", rows[0])
        self.assertNotIn("light_results", rows[0])

    def test_candidate_rows_filter_goal_context_and_long_windows(self) -> None:
        windows = [
            {"id": "event_window:goal", "text": "<goal_context> continue", "approx_tokens": 10},
            {"id": "event_window:subagent", "text": "USER:\n<subagent_notification> {}", "approx_tokens": 10},
            {"id": "event_window:long", "text": "USER:\nhello", "approx_tokens": 900},
            {"id": "event_window:ok", "text": "USER:\nhello", "approx_tokens": 2},
        ]

        rows = module.build_blind_rows(windows, limit=10, seed=1, max_tokens=384)

        self.assertEqual([row["source_window_id"] for row in rows], ["event_window:ok"])

    def test_render_brief_lists_allowed_labels_and_rows(self) -> None:
        rows = [
            {
                "id": "blind-session-sections/a",
                "source_window_id": "event_window:a",
                "source_turn": "turn:a",
                "source_session": "session:s1",
                "source_seq": 4,
                "label": "__pending__",
                "target": "__pending__",
                "text": "USER:\ncontinue",
                "approx_tokens": 2,
                "evidence": [],
                "review_notes": "",
            }
        ]

        brief = module.render_brief(rows)

        self.assertIn("Allowed labels", brief)
        self.assertIn("approval", brief)
        self.assertIn("blind-session-sections/a", brief)
        self.assertIn("USER:\ncontinue", brief)

    def test_report_marks_missing_rows_as_failure(self) -> None:
        report = module.build_report(rows=[], source_count=20, limit=10, out="blind.jsonl", brief="blind.md")

        self.assertEqual(report["sampled_rows"], 0)
        self.assertIn("no blind rows sampled", report["failures"])


if __name__ == "__main__":
    unittest.main()
