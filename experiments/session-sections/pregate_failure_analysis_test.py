import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("pregate_failure_analysis.py")
spec = importlib.util.spec_from_file_location("session_section_pregate_failure_analysis", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_pregate_failure_analysis"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class PreGateFailureAnalysisTest(unittest.TestCase):
    def test_apply_overrides_reconstructs_final_predictions(self) -> None:
        examples = [
            {"id": "n1", "actual": "none", "predicted": "approval"},
            {"id": "a1", "actual": "approval", "predicted": "approval"},
        ]
        overrides = [{"id": "n1", "reason": "completed_workflow_next_question"}]

        final = module.apply_overrides(examples, overrides)

        self.assertEqual(final, [
            {"id": "n1", "actual": "none", "predicted": "none", "override_reason": "completed_workflow_next_question"},
            {"id": "a1", "actual": "approval", "predicted": "approval", "override_reason": None},
        ])

    def test_misses_excludes_correct_and_overridden_rows(self) -> None:
        final = [
            {"id": "n1", "actual": "none", "predicted": "none", "override_reason": "gate"},
            {"id": "a1", "actual": "approval", "predicted": "approval", "override_reason": None},
            {"id": "v1", "actual": "verification_or_recovery_signal", "predicted": "approval", "override_reason": None},
        ]

        misses = module.misses(final)

        self.assertEqual(misses, [
            {"id": "v1", "actual": "verification_or_recovery_signal", "predicted": "approval", "override_reason": None},
        ])

    def test_pair_counts_groups_remaining_misses(self) -> None:
        misses = [
            {"id": "a1", "actual": "approval", "predicted": "verification_or_recovery_signal"},
            {"id": "a2", "actual": "approval", "predicted": "verification_or_recovery_signal"},
            {"id": "c1", "actual": "correction_or_rejection_signal", "predicted": "environment_or_preference_signal"},
        ]

        self.assertEqual(module.pair_counts(misses), [
            {"actual": "approval", "predicted": "verification_or_recovery_signal", "count": 2},
            {"actual": "correction_or_rejection_signal", "predicted": "environment_or_preference_signal", "count": 1},
        ])


if __name__ == "__main__":
    unittest.main()
