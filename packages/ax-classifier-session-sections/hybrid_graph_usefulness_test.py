import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("hybrid_graph_usefulness.py")
spec = importlib.util.spec_from_file_location("hybrid_graph_usefulness", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["hybrid_graph_usefulness"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def fixture(row_id: str, source_group: str = "workflow-fixture") -> dict[str, str]:
    return {
        "id": row_id,
        "source_group": source_group,
        "text": f"USER: useful context for {row_id}",
    }


def examples(prediction_for_none: str) -> list[dict[str, str]]:
    return [
        {"id": "approval", "actual": "approval", "predicted": "approval"},
        {"id": "correction", "actual": "correction_or_rejection_signal", "predicted": "correction_or_rejection_signal"},
        {"id": "preference", "actual": "environment_or_preference_signal", "predicted": "environment_or_preference_signal"},
        {"id": "verification", "actual": "verification_or_recovery_signal", "predicted": "verification_or_recovery_signal"},
        {"id": "none", "actual": "none", "predicted": prediction_for_none},
    ]


class HybridGraphUsefulnessTest(unittest.TestCase):
    def test_build_report_passes_when_hybrid_removes_baseline_graph_noise(self) -> None:
        fixtures = {row_id: fixture(row_id) for row_id in ["approval", "correction", "preference", "verification", "none"]}
        report = module.build_report(
            {
                "schema": "robustness",
                "decision": "needs_quality_work",
                "runs": [{"seed": 7, "calibrated": {"examples": examples("environment_or_preference_signal")}}],
            },
            {
                "schema": "hybrid",
                "decision": "hybrid_robust_enough",
                "harmful_override_count_total": 0,
                "runs": [{"seed": 7, "examples": examples("none")}],
            },
            fixtures,
        )

        self.assertEqual(report["decision"], "hybrid_graph_usefulness_ready")
        self.assertEqual(report["summary"]["baseline_graph_noise_count_total"], 1)
        self.assertEqual(report["summary"]["hybrid_graph_noise_count_total"], 0)
        self.assertEqual(report["summary"]["removed_graph_noise_count_total"], 1)
        self.assertEqual(report["summary"]["hybrid_candidate_group_count_min"], 4)

    def test_build_report_fails_when_hybrid_introduces_none_graph_noise(self) -> None:
        fixtures = {row_id: fixture(row_id) for row_id in ["approval", "correction", "preference", "verification", "none"]}
        report = module.build_report(
            {
                "runs": [{"seed": 7, "calibrated": {"examples": examples("none")}}],
            },
            {
                "decision": "hybrid_robust_enough",
                "harmful_override_count_total": 0,
                "runs": [{"seed": 7, "examples": examples("verification_or_recovery_signal")}],
            },
            fixtures,
        )

        self.assertEqual(report["decision"], "needs_hybrid_graph_usefulness_work")
        self.assertEqual(report["summary"]["introduced_graph_noise_count_total"], 1)
        self.assertIn("hybrid predictions would add graph noise from none rows", report["summary"]["failures"])

    def test_build_report_fails_when_hybrid_decision_is_not_ready(self) -> None:
        fixtures = {row_id: fixture(row_id) for row_id in ["approval", "correction", "preference", "verification", "none"]}
        report = module.build_report(
            {
                "runs": [{"seed": 7, "calibrated": {"examples": examples("environment_or_preference_signal")}}],
            },
            {
                "decision": "needs_hybrid_quality_work",
                "harmful_override_count_total": 0,
                "runs": [{"seed": 7, "examples": examples("none")}],
            },
            fixtures,
        )

        self.assertEqual(report["decision"], "needs_hybrid_graph_usefulness_work")
        self.assertIn("hybrid robustness report is not ready", report["summary"]["failures"])


if __name__ == "__main__":
    unittest.main()
