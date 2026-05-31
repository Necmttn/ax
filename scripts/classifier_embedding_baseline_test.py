import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("classifier-embedding-baseline.py")
spec = importlib.util.spec_from_file_location("classifier_embedding_baseline", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["classifier_embedding_baseline"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class ClassifierEmbeddingBaselineTest(unittest.TestCase):
    def test_macro_f1_reports_per_label_metrics(self) -> None:
        macro, per_label = module.macro_f1(
            ["direction", "direction", "none", "none"],
            ["direction", "none", "none", "direction"],
        )

        self.assertAlmostEqual(macro, 0.5)
        self.assertEqual(per_label["direction"]["support"], 2)
        self.assertEqual(per_label["none"]["support"], 2)

    def test_confusion_counts_groups_actual_then_predicted(self) -> None:
        self.assertEqual(
            module.confusion_counts(["none", "none", "direction"], ["none", "direction", "direction"]),
            {
                "none": {"none": 1, "direction": 1},
                "direction": {"direction": 1},
            },
        )

    def test_threshold_sweep_can_force_low_confidence_predictions_to_none(self) -> None:
        predictions = module.threshold_predictions(["direction", "correction", "none"], [0.9, 0.4, 0.8], 0.5)
        self.assertEqual(predictions, ["direction", "none", "none"])

        sweep = module.threshold_sweep(["direction", "none"], ["direction", "direction"], [0.9, 0.2])
        safe = [row for row in sweep if row["none_false_positive_rate"] == 0]
        self.assertTrue(any(row["threshold"] >= 0.25 for row in safe))

    def test_fixture_text_uses_stable_projection_blocks(self) -> None:
        text = module.fixture_text(
            {
                "user": "can you use uv?",
                "previousAssistant": "pip failed",
                "recentToolFailures": ["dependency conflict"],
            }
        )

        self.assertIn("USER:\ncan you use uv?", text)
        self.assertIn("PREVIOUS_ASSISTANT:\npip failed", text)
        self.assertIn("RECENT_TOOL_FAILURES:\ndependency conflict", text)

    def test_primary_label_maps_empty_expectations_to_none(self) -> None:
        self.assertEqual(module.primary_label({"expect": []}), ("none", "none"))
        self.assertEqual(
            module.primary_label({"expect": [{"label": "direction", "target": "tooling_preference"}]}),
            ("direction", "tooling_preference"),
        )

    def test_load_examples_accepts_jsonl_chunk_fixtures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "chunks.jsonl"
            path.write_text(
                '{"id":"chunk/a","suite":"chunks","name":"a","label":"direction","target":"tooling_preference","text":"USER:\\nuse uv"}\n'
                '{"id":"chunk/b","suite":"chunks","name":"b","label":"none","target":"none","window":{"user":"what next?"}}\n'
            )

            examples = module.load_examples([str(path)])

        self.assertEqual([example.id for example in examples], ["chunk/a", "chunk/b"])
        self.assertEqual([example.label for example in examples], ["direction", "none"])
        self.assertIn("USER:\nwhat next?", examples[1].text)


if __name__ == "__main__":
    unittest.main()
