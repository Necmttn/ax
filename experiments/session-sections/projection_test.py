import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("projection.py")
spec = importlib.util.spec_from_file_location("session_section_projection", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_projection"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class ProjectionTest(unittest.TestCase):
    def test_parse_blocks_extracts_known_sections(self) -> None:
        blocks = module.parse_text_blocks(
            "USER:\nshow me the results\n\nPREVIOUS_ASSISTANT:\nI opened the HTML.\n\nRECENT_TOOL_FAILURES:\npytest failed"
        )

        self.assertEqual(blocks["USER"], "show me the results")
        self.assertEqual(blocks["PREVIOUS_ASSISTANT"], "I opened the HTML.")
        self.assertEqual(blocks["RECENT_TOOL_FAILURES"], "pytest failed")

    def test_project_text_adds_intent_and_prior_action_without_labels(self) -> None:
        projected = module.project_text(
            "USER:\ni dont want just html, i want the actual results\n\nPREVIOUS_ASSISTANT:\nI created a static prototype page and stopped there."
        )

        self.assertIn("USER_INTENT_CUES:\nrejection_or_correction, verification_request", projected)
        self.assertIn("PRIOR_ACTION_CUES:\ncreated_artifact, stopped_short", projected)
        self.assertIn("REQUESTED_NEXT_ACTION_CUES:\nshow_results", projected)
        self.assertNotIn("direction", projected.lower())
        self.assertNotIn("label", projected.lower())

    def test_project_raw_fields_adds_boundaries_without_cues(self) -> None:
        projected = module.project_text(
            "USER:\nshow me the results\n\nPREVIOUS_ASSISTANT:\nI opened the HTML.",
            mode="raw",
        )

        self.assertEqual(
            projected,
            "FIELD user_message\nshow me the results\nEND_FIELD\n\nFIELD previous_agent_action\nI opened the HTML.\nEND_FIELD",
        )
        self.assertNotIn("CUES", projected)

    def test_transform_rows_preserves_metadata_and_rewrites_text(self) -> None:
        rows = [
            {
                "id": "case-a",
                "label": "direction",
                "target": "output_expectation",
                "text": "USER:\nuse uv\n\nPREVIOUS_ASSISTANT:\npip install failed",
            }
        ]

        transformed = module.transform_rows(rows)

        self.assertEqual(transformed[0]["id"], "case-a")
        self.assertEqual(transformed[0]["label"], "direction")
        self.assertEqual(transformed[0]["target"], "output_expectation")
        self.assertIn("USER_INTENT_CUES:\ntooling_or_environment", transformed[0]["text"])
        self.assertIn("PRIOR_ACTION_CUES:\ntool_failure", transformed[0]["text"])


if __name__ == "__main__":
    unittest.main()
