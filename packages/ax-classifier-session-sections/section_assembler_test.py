import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("section_assembler.py")
spec = importlib.util.spec_from_file_location("session_section_assembler", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_assembler"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class SectionAssemblerTest(unittest.TestCase):
    def test_assemble_merges_same_type_within_gap(self) -> None:
        sections = module.assemble_sections([
            {"seq": 1, "label": "direction", "evidence": ["turn:1"]},
            {"seq": 2, "label": "none"},
            {"seq": 3, "label": "tooling_or_environment_issue", "evidence": ["tool_call:1"]},
            {"seq": 8, "label": "correction", "evidence": ["turn:8"]},
        ])

        self.assertEqual(sections[0]["section_type"], "preference_discovery")
        self.assertEqual((sections[0]["start_seq"], sections[0]["end_seq"]), (1, 3))
        self.assertEqual(sections[0]["evidence"], ["tool_call:1", "turn:1"])
        self.assertEqual(sections[1]["section_type"], "correction_loop")

    def test_span_overlap_uses_inclusive_turn_ranges(self) -> None:
        self.assertEqual(
            module.span_overlap({"start_seq": 2, "end_seq": 4}, {"start_seq": 3, "end_seq": 5}),
            0.5,
        )

    def test_evaluate_fixture_reports_gates(self) -> None:
        data = {
            "name": "tiny",
            "sessions": [
                {
                    "id": "s1",
                    "turns": [{"seq": 1, "label": "direction", "evidence": ["turn:1"]}],
                    "expected": [{"section_type": "preference_discovery", "start_seq": 1, "end_seq": 1}],
                }
            ],
        }
        report = module.evaluate_fixture(data, max_gap=2)

        self.assertEqual(report["matched_sections"], 1)
        self.assertEqual(report["boundary_overlap"], 1.0)
        self.assertIn("less than 10 labeled session fixtures", report["failures"])


if __name__ == "__main__":
    unittest.main()
