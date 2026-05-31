import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("failure_analysis.py")
spec = importlib.util.spec_from_file_location("session_section_failure_analysis", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_failure_analysis"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class FailureAnalysisTest(unittest.TestCase):
    def test_weak_labels_include_example_targets(self) -> None:
        weak = module.weak_labels({
            "labels": {"verification_request": 8, "none": 22},
            "per_label": {
                "verification_request": {"f1": 0.0, "support": 2},
                "none": {"f1": 0.75, "support": 6},
            },
        })

        self.assertEqual(weak, [
            {
                "label": "verification_request",
                "f1": 0.0,
                "support": 2,
                "fixture_count": 8,
                "additional_examples_target": 4,
            }
        ])

    def test_confusion_pairs_exclude_correct_predictions(self) -> None:
        pairs = module.confusion_pairs({
            "confusion": {
                "none": {"none": 6, "direction": 2},
                "verification_request": {"none": 1},
            }
        })

        self.assertEqual(pairs, [
            {"actual": "none", "predicted": "direction", "count": 2},
            {"actual": "verification_request", "predicted": "none", "count": 1},
        ])

    def test_analyze_failures_builds_labeling_tasks_from_misclassifications(self) -> None:
        report = {
            "macro_f1": 0.2,
            "none_false_positive_rate": 0.0,
            "labels": {"verification_request": 8},
            "per_label": {"verification_request": {"f1": 0.0, "support": 2}},
            "confusion": {"verification_request": {"none": 1}},
            "examples": [
                {"id": "case-a", "actual": "verification_request", "predicted": "none"},
                {"id": "case-b", "actual": "verification_request", "predicted": "verification_request"},
            ],
        }
        analysis = module.analyze_failures(report, report)

        self.assertEqual(analysis["schema"], "ax.setfit_failure_analysis.v1")
        self.assertEqual(analysis["labeling_tasks"][0]["example_ids"], ["case-a"])
        self.assertEqual(analysis["labeling_tasks"][0]["confused_with"], ["none"])

    def test_enrich_misses_classifies_confusion_families(self) -> None:
        misses = module.enrich_misses(
            [
                {"id": "none-case", "actual": "none", "predicted": "approval"},
                {"id": "signal-case", "actual": "environment_or_preference_signal", "predicted": "none"},
                {"id": "approval-case", "actual": "approval", "predicted": "verification_or_recovery_signal"},
            ],
            {
                "none-case": {"label": "none", "target": "none", "text": "USER:\nstart"},
                "signal-case": {"label": "direction", "target": "package", "text": "USER:\npackage it"},
                "approval-case": {"label": "approval", "target": "continue", "text": "USER:\nyes"},
            },
            {"none-case": 0.44, "signal-case": 0.30, "approval-case": 0.68},
        )

        self.assertEqual([miss["family"] for miss in misses], [
            "none_false_positive",
            "missed_signal",
            "approval_boundary",
        ])
        self.assertEqual(misses[1]["fine_label"], "direction")
        self.assertEqual(misses[2]["confidence"], 0.68)

    def test_analyze_robustness_selects_worst_seed_and_recommendations(self) -> None:
        report = {
            "model": "test-model",
            "label_mode": "coarse",
            "fixtures": 3,
            "epochs": 2,
            "batch_size": 8,
            "calibration_threshold": 0.4,
            "decision": "needs_model_quality_work",
            "failures": ["minimum macro F1 is below 0.70"],
            "summary": {"macro_f1_min": 0.6, "none_false_positive_rate_max": 0.2},
            "calibrated_summary": {"macro_f1_min": 0.5, "none_false_positive_rate_max": 0.2},
            "runs": [
                {
                    "seed": 1,
                    "accuracy": 0.8,
                    "macro_f1": 0.8,
                    "none_false_positive_rate": 0.0,
                    "examples": [],
                    "raw_predictions_with_confidence": [],
                    "calibrated": {
                        "accuracy": 0.8,
                        "macro_f1": 0.8,
                        "none_false_positive_rate": 0.0,
                        "examples": [],
                    },
                },
                {
                    "seed": 7,
                    "accuracy": 0.6,
                    "macro_f1": 0.6,
                    "none_false_positive_rate": 0.2,
                    "examples": [
                        {"id": "none-case", "actual": "none", "predicted": "approval"},
                    ],
                    "raw_predictions_with_confidence": [
                        {"id": "none-case", "actual": "none", "predicted": "approval", "confidence": 0.7},
                    ],
                    "calibrated": {
                        "accuracy": 0.5,
                        "macro_f1": 0.5,
                        "none_false_positive_rate": 0.2,
                        "examples": [
                            {"id": "none-case", "actual": "none", "predicted": "approval"},
                        ],
                    },
                },
            ],
        }
        analysis = module.analyze_robustness(report, {
            "none-case": {"label": "none", "target": "none", "text": "USER:\nstart"},
        })

        self.assertEqual(analysis["schema"], "ax.setfit_robustness_failure_analysis.v1")
        self.assertEqual(analysis["decision"], "needs_none_safety_review")
        self.assertFalse(analysis["gate"]["passed"])
        self.assertEqual(analysis["worst_seed"], 7)
        self.assertEqual(analysis["calibrated_family_counts"], {"none_false_positive": 1})
        self.assertEqual(analysis["all_seed_calibrated_family_counts"], {"none_false_positive": 1})
        self.assertEqual(analysis["all_seed_calibrated_source_group_counts"], {"unknown": 1})
        self.assertEqual(analysis["all_seed_none_false_positive_count"], 1)
        self.assertEqual(analysis["all_seed_unique_none_false_positive_count"], 1)
        self.assertEqual(analysis["all_seed_none_false_positives"][0]["seeds"], [7])
        self.assertEqual(analysis["high_confidence_misses"][0]["id"], "none-case")
        self.assertIn("Keep deterministic classifiers", analysis["recommended_next_actions"][0])

    def test_aggregate_none_false_positives_counts_repeated_seed_hits(self) -> None:
        rows = module.aggregate_none_false_positives([
            {
                "id": "none-case",
                "actual": "none",
                "predicted": "approval",
                "family": "none_false_positive",
                "confidence": 0.6,
                "seed": 7,
                "target": "none",
                "source_group": "session-section-chunks",
                "boundary_group": "none_continuation_question",
                "pair_group": "continue_state_boundary",
                "text_excerpt": "USER: what next?",
            },
            {
                "id": "none-case",
                "actual": "none",
                "predicted": "verification_or_recovery_signal",
                "family": "none_false_positive",
                "confidence": 0.8,
                "seed": 13,
                "target": "none",
                "source_group": "session-section-chunks",
                "boundary_group": "none_continuation_question",
                "pair_group": "continue_state_boundary",
                "text_excerpt": "USER: what next?",
            },
            {
                "id": "signal-case",
                "actual": "approval",
                "predicted": "none",
                "family": "missed_signal",
                "confidence": 0.9,
                "seed": 13,
            },
        ])

        self.assertEqual(rows, [
            {
                "id": "none-case",
                "actual": "none",
                "predicted_labels": ["approval", "verification_or_recovery_signal"],
                "seeds": [7, 13],
                "hit_count": 2,
                "max_confidence": 0.8,
                "fine_label": None,
                "target": "none",
                "source_group": "session-section-chunks",
                "boundary_group": "none_continuation_question",
                "pair_group": "continue_state_boundary",
                "text_excerpt": "USER: what next?",
            }
        ])

    def test_analyze_robustness_reports_gate_pass_with_residual_review(self) -> None:
        report = {
            "model": "test-model",
            "label_mode": "coarse",
            "fixtures": 4,
            "epochs": 1,
            "batch_size": 8,
            "calibration_threshold": 0.4,
            "decision": "robust_enough",
            "failures": [],
            "summary": {"macro_f1_min": 0.76, "none_false_positive_rate_max": 0.05},
            "calibrated_summary": {"macro_f1_min": 0.76, "none_false_positive_rate_max": 0.05},
            "runs": [
                {
                    "seed": 7,
                    "accuracy": 0.8,
                    "macro_f1": 0.76,
                    "none_false_positive_rate": 0.05,
                    "examples": [
                        {"id": "none-case", "actual": "none", "predicted": "environment_or_preference_signal"},
                        {"id": "helper-case", "actual": "none", "predicted": "none"},
                    ],
                    "raw_predictions_with_confidence": [
                        {"id": "none-case", "actual": "none", "predicted": "environment_or_preference_signal", "confidence": 0.47},
                        {"id": "helper-case", "actual": "none", "predicted": "none", "confidence": 0.91},
                    ],
                    "calibrated": {
                        "accuracy": 0.8,
                        "macro_f1": 0.76,
                        "none_false_positive_rate": 0.05,
                        "examples": [
                            {"id": "none-case", "actual": "none", "predicted": "environment_or_preference_signal"},
                            {"id": "helper-case", "actual": "none", "predicted": "none"},
                        ],
                    },
                },
                {
                    "seed": 13,
                    "accuracy": 0.8,
                    "macro_f1": 0.77,
                    "none_false_positive_rate": 0.05,
                    "examples": [
                        {"id": "none-case", "actual": "none", "predicted": "environment_or_preference_signal"},
                    ],
                    "raw_predictions_with_confidence": [
                        {"id": "none-case", "actual": "none", "predicted": "environment_or_preference_signal", "confidence": 0.49},
                    ],
                    "calibrated": {
                        "accuracy": 0.8,
                        "macro_f1": 0.77,
                        "none_false_positive_rate": 0.05,
                        "examples": [
                            {"id": "none-case", "actual": "none", "predicted": "environment_or_preference_signal"},
                        ],
                    },
                },
            ],
        }
        analysis = module.analyze_robustness(report, {
            "none-case": {
                "label": "none",
                "target": "none",
                "source_group": "session-section-chunks",
                "boundary_group": "none_model_question",
                "pair_group": "none_model_question::none",
                "text": "USER:\nhow big is the model?",
            },
            "helper-case": {
                "label": "none",
                "target": "none",
                "source_group": "embedding-helper-hard-negative",
                "text": "USER:\nwhat was the task?",
            },
        })

        self.assertTrue(analysis["gate"]["passed"])
        self.assertEqual(analysis["decision"], "robust_with_residual_none_false_positive_review")
        self.assertEqual(analysis["all_seed_calibrated_source_group_counts"], {"session-section-chunks": 2})
        self.assertEqual(analysis["all_seed_repeated_misses"][0]["id"], "none-case")
        self.assertIn("Do not run another broad hard-negative mining pass yet", analysis["recommended_next_actions"][0])

    def test_analyze_robustness_reports_ready_when_gate_passes_without_none_fp(self) -> None:
        report = {
            "decision": "robust_enough",
            "failures": [],
            "summary": {"macro_f1_min": 0.8, "none_false_positive_rate_max": 0.0},
            "calibrated_summary": {"macro_f1_min": 0.8, "none_false_positive_rate_max": 0.0},
            "runs": [
                {
                    "seed": 7,
                    "accuracy": 1.0,
                    "macro_f1": 1.0,
                    "none_false_positive_rate": 0.0,
                    "examples": [{"id": "ok", "actual": "none", "predicted": "none"}],
                    "raw_predictions_with_confidence": [],
                    "calibrated": {
                        "accuracy": 1.0,
                        "macro_f1": 1.0,
                        "none_false_positive_rate": 0.0,
                        "examples": [{"id": "ok", "actual": "none", "predicted": "none"}],
                    },
                }
            ],
        }

        analysis = module.analyze_robustness(report, {"ok": {"label": "none", "text": "USER:\nok"}})

        self.assertEqual(analysis["decision"], "ready_for_fixture_promotion_review")
        self.assertEqual(analysis["all_seed_repeated_misses"], [])


if __name__ == "__main__":
    unittest.main()
