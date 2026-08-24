import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("relabel_audit.py")
spec = importlib.util.spec_from_file_location("session_section_relabel_audit", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_relabel_audit"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class RelabelAuditTest(unittest.TestCase):
    def test_audit_item_flags_approval_none_contract_ambiguity(self) -> None:
        item = module.audit_item(
            {
                "id": "case",
                "label": "none",
                "target": "none",
                "text": "USER:\nalright lets build this\n\nPREVIOUS_ASSISTANT:\nI presented a design.",
            },
            {"actual": "none", "predicted": "approval", "confidence": 0.7},
        )

        self.assertEqual(item["recommendation"], "needs_contract_decision")
        self.assertEqual(item["issue"], "approval_vs_none_boundary")

    def test_audit_item_keeps_direction_missed_as_none(self) -> None:
        item = module.audit_item(
            {
                "id": "case",
                "label": "direction",
                "target": "package_contribution",
                "text": "USER:\nmake classifiers dedicated packages",
            },
            {"actual": "environment_or_preference_signal", "predicted": "none", "confidence": 0.3},
        )

        self.assertEqual(item["recommendation"], "keep_label_add_contrast")
        self.assertEqual(item["issue"], "missed_signal")

    def test_analyze_relabel_candidates_counts_recommendations(self) -> None:
        analysis = module.analyze_relabel_candidates(
            {
                "runs": [
                    {
                        "seed": 7,
                        "raw_predictions_with_confidence": [
                            {"id": "case-a", "actual": "none", "predicted": "approval", "confidence": 0.7},
                            {"id": "case-b", "actual": "environment_or_preference_signal", "predicted": "none", "confidence": 0.3},
                        ],
                        "calibrated": {
                            "macro_f1": 0.6,
                            "none_false_positive_rate": 0.1,
                            "examples": [
                                {"id": "case-a", "actual": "none", "predicted": "approval"},
                                {"id": "case-b", "actual": "environment_or_preference_signal", "predicted": "none"},
                            ],
                        },
                    }
                ]
            },
            {
                "case-a": {"id": "case-a", "label": "none", "target": "none", "text": "USER:\nlets build this"},
                "case-b": {"id": "case-b", "label": "direction", "target": "package", "text": "USER:\npackage it"},
            },
        )

        self.assertEqual(analysis["schema"], "ax.setfit_relabel_audit.v1")
        self.assertEqual(analysis["summary"]["recommendations"]["needs_contract_decision"], 1)
        self.assertEqual(analysis["summary"]["recommendations"]["keep_label_add_contrast"], 1)


if __name__ == "__main__":
    unittest.main()
