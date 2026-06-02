#!/usr/bin/env python3
"""Tests for the optional embedding/SVM transcript-label prioritizer.

The prioritizer is advisory only: it ranks weak-label candidates by their
nearest *reviewed* examples and surfaces hard negatives. It must never emit a
``promotion_safe=true`` field on any row or in the report (only human-reviewed
graph projection may set that).
"""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("label_mining_priority.py")
spec = importlib.util.spec_from_file_location("session_section_label_mining_priority", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_label_mining_priority"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def make_candidate(cid: str, label_family: str, weak_label: str, vec: list[float]) -> dict:
    return {
        "id": cid,
        "candidate_id": cid,
        "label_family": label_family,
        "weak_label": weak_label,
        "weak_confidence": 0.8,
        "target": weak_label,
        "excerpt": f"excerpt for {cid}",
        "evidence_paths": [f"turn:{cid}"],
        "embedding": vec,
    }


def make_reviewed(cid: str, reviewed_label: str, vec: list[float]) -> dict:
    return {
        "candidate_id": cid,
        "review_status": "accepted",
        "reviewed_label": reviewed_label,
        "reviewed_target": reviewed_label,
        "embedding": vec,
    }


class LabelMiningPriorityTest(unittest.TestCase):
    def test_ranks_candidates_by_nearest_reviewed_examples(self) -> None:
        candidates = [
            make_candidate("c_far", "correction", "correction", [0.0, 1.0]),
            make_candidate("c_near", "correction", "correction", [1.0, 0.0]),
        ]
        reviewed = [
            make_reviewed("r1", "correction", [1.0, 0.0]),
        ]

        result = module.prioritize(candidates, reviewed, embedding_model="precomputed")
        ranked = result["ranked_candidates"]

        # The candidate whose embedding matches a reviewed example must rank first.
        self.assertEqual(ranked[0]["candidate_id"], "c_near")
        self.assertEqual(ranked[0]["nearest_reviewed_candidate_ids"][0], "r1")
        self.assertGreater(ranked[0]["nearest_scores"][0], ranked[1]["nearest_scores"][0])

    def test_surfaces_hard_negatives_when_nearest_label_differs(self) -> None:
        candidates = [
            make_candidate("c_agree", "correction", "correction", [1.0, 0.0]),
            make_candidate("c_conflict", "correction", "correction", [0.0, 1.0]),
        ]
        reviewed = [
            make_reviewed("r_corr", "correction", [1.0, 0.0]),
            make_reviewed("r_dir", "direction", [0.0, 1.0]),
        ]

        result = module.prioritize(candidates, reviewed, embedding_model="precomputed")
        by_id = {row["candidate_id"]: row for row in result["ranked_candidates"]}

        # c_conflict's nearest reviewed example is labelled "direction" but its
        # weak label is "correction" -> hard negative.
        self.assertTrue(by_id["c_conflict"]["hard_negative"])
        self.assertEqual(by_id["c_conflict"]["nearest_reviewed_label"], "direction")
        self.assertFalse(by_id["c_agree"]["hard_negative"])
        self.assertIn("c_conflict", result["hard_negative_candidate_ids"])

    def test_output_never_marks_promotion_safe_true(self) -> None:
        candidates = [make_candidate("c1", "correction", "correction", [1.0, 0.0])]
        reviewed = [make_reviewed("r1", "correction", [1.0, 0.0])]

        result = module.prioritize(candidates, reviewed, embedding_model="precomputed")

        serialized = json.dumps(result)
        self.assertNotIn("promotion_safe=true", serialized)
        self.assertNotIn('"promotion_safe": true', serialized)
        self.assertNotIn('"promotion_safe":true', serialized)
        # Explicit advisory marker proves these rows are model-only.
        self.assertFalse(result["promotion_safe"])
        for row in result["ranked_candidates"]:
            self.assertFalse(row.get("promotion_safe", False))

    def test_precision_at_20_reported_when_reviewed_labels_present(self) -> None:
        candidates = [
            make_candidate("c1", "correction", "correction", [1.0, 0.0]),
            make_candidate("c2", "direction", "direction", [0.0, 1.0]),
        ]
        reviewed = [
            make_reviewed("c1", "correction", [1.0, 0.0]),
            make_reviewed("c2", "direction", [0.0, 1.0]),
        ]

        result = module.prioritize(candidates, reviewed, embedding_model="precomputed")

        self.assertIn("precision_at_20", result)
        self.assertIsInstance(result["precision_at_20"], float)
        # Both candidates have a reviewed label matching their weak label.
        self.assertEqual(result["precision_at_20"], 1.0)

    def test_missing_embedding_model_fails_with_clear_error(self) -> None:
        candidates = [make_candidate("c1", "correction", "correction", [1.0, 0.0])]
        reviewed = [make_reviewed("r1", "correction", [1.0, 0.0])]

        with self.assertRaises(module.EmbeddingModelError) as ctx:
            module.prioritize(candidates, reviewed, embedding_model="")

        self.assertIn("embedding model", str(ctx.exception).lower())

    def test_load_reviewed_keeps_single_row_jsonl(self) -> None:
        import tempfile

        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
            fh.write(json.dumps({"candidate_id": "r1", "reviewed_label": "correction"}))
            path = fh.name

        rows = module.load_reviewed(path)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["candidate_id"], "r1")

    def test_missing_precomputed_embedding_fails_with_clear_error(self) -> None:
        # When embedding_model is "precomputed" every row must carry a vector.
        candidates = [
            {
                "id": "c1",
                "candidate_id": "c1",
                "label_family": "correction",
                "weak_label": "correction",
                "weak_confidence": 0.8,
                "excerpt": "no vector here",
                "evidence_paths": ["turn:c1"],
            }
        ]
        reviewed = [make_reviewed("r1", "correction", [1.0, 0.0])]

        with self.assertRaises(module.EmbeddingModelError) as ctx:
            module.prioritize(candidates, reviewed, embedding_model="precomputed")

        self.assertIn("embedding", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
