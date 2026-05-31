import json
import unittest
from collections import Counter
from pathlib import Path


FIXTURES = Path(__file__).parent / "eval-fixtures" / "chunks.jsonl"


def load_rows() -> list[dict[str, object]]:
    return [json.loads(line) for line in FIXTURES.read_text().splitlines() if line.strip()]


class FixtureQualityTest(unittest.TestCase):
    def test_fixture_ids_are_unique(self) -> None:
        rows = load_rows()
        ids = [str(row["id"]) for row in rows]

        duplicates = [row_id for row_id, count in Counter(ids).items() if count > 1]

        self.assertEqual(duplicates, [])

    def test_targeted_e38_examples_exist(self) -> None:
        names = {str(row["name"]) for row in load_rows()}

        expected_names = {
            "approval-continue-where-left-off",
            "approval-go-ahead-next",
            "approval-ship-it",
            "approval-keep-moving",
            "none-eval-framework-question",
            "none-goal-benchmark-question",
            "none-results-comparison",
            "none-model-size-question",
            "correction-status-was-wrong",
            "correction-commit-claim-wrong",
            "tooling-docker-instead-of-host",
            "tooling-nix-local-db-match",
        }

        self.assertEqual(sorted(expected_names - names), [])


if __name__ == "__main__":
    unittest.main()
