import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("none_safety_window_replay.py")
spec = importlib.util.spec_from_file_location("session_section_none_safety_window_replay", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_none_safety_window_replay"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class NoneSafetyWindowReplayTest(unittest.TestCase):
    def test_build_report_counts_holdout_hits_and_conflicts(self) -> None:
        report = module.build_report([
            {
                "id": "w1",
                "turn": "turn:1",
                "text": "USER:\nwhat was the task i gave you?\n\nPREVIOUS_ASSISTANT:\nThe user wants context recall.",
                "light_labels": [],
                "light_results": [],
            },
            {
                "id": "w2",
                "turn": "turn:2",
                "text": "USER:\nhow large is the trained model and where would contributors download it from?",
                "light_labels": ["direction"],
                "light_results": [
                    {
                        "classifier_key": "direction-event",
                        "label": "direction",
                        "target": "tooling_preference",
                        "confidence": 0.86,
                    }
                ],
            },
            {
                "id": "w3",
                "turn": "turn:3",
                "text": "USER:\nship it\n\nPREVIOUS_ASSISTANT:\nI proposed the next implementation.",
                "light_labels": ["approval"],
            },
        ])

        self.assertEqual(report["decision"], "needs_conflict_review")
        self.assertEqual(report["summary"]["windows"], 3)
        self.assertEqual(report["summary"]["gate_hits"], 2)
        self.assertEqual(report["summary"]["potential_conflicts"], 1)
        self.assertEqual(report["summary"]["reason_counts"]["context_recall_question"], 1)
        self.assertEqual(report["summary"]["conflict_label_counts"], {"direction": 1})

    def test_build_report_marks_candidate_when_hits_have_no_light_label_conflicts(self) -> None:
        report = module.build_report([
            {
                "id": "w1",
                "text": "USER:\nhow large is the trained model and where would contributors download it from?",
                "light_labels": [],
            }
        ])

        self.assertEqual(report["decision"], "candidate_none_safety_gate_holdout")
        self.assertEqual(report["summary"]["potential_conflict_rate"], 0.0)

    def test_build_report_handles_no_hits(self) -> None:
        report = module.build_report([
            {
                "id": "w1",
                "text": "USER:\nplease run the tests",
                "light_labels": ["verification_request"],
            }
        ])

        self.assertEqual(report["decision"], "no_gate_hits_on_holdout")
        self.assertEqual(report["summary"]["gate_hit_rate"], 0.0)


if __name__ == "__main__":
    unittest.main()
