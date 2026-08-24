import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("fixture_metadata.py")
spec = importlib.util.spec_from_file_location("session_section_fixture_metadata", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_fixture_metadata"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class FixtureMetadataTest(unittest.TestCase):
    def test_boundary_group_splits_monolithic_approval_target(self) -> None:
        approval_continue = {
            "name": "approval-continue-evals",
            "label": "approval",
            "target": "continue",
            "text": "USER:\ncontinue with evals",
        }
        approval_package = {
            "name": "approval-yes-package-it",
            "label": "approval",
            "target": "continue",
            "text": "USER:\nyes package it",
        }

        self.assertEqual(module.boundary_group_for(approval_continue), "approval_continue_eval")
        self.assertEqual(module.boundary_group_for(approval_package), "approval_package")

    def test_boundary_group_splits_approval_shorthand_styles(self) -> None:
        approval_next = {
            "name": "approval-looks-good-next",
            "label": "approval",
            "target": "continue",
            "text": "USER:\nlooks good, what is next?",
        }
        approval_start = {
            "name": "approval-okay-run-it",
            "label": "approval",
            "target": "continue",
            "text": "USER:\nokay run it",
        }
        approval_resume = {
            "name": "approval-continue",
            "label": "approval",
            "target": "continue",
            "text": "USER:\ncontinue",
        }

        self.assertEqual(module.boundary_group_for(approval_next), "approval_next_step")
        self.assertEqual(module.boundary_group_for(approval_start), "approval_start_work")
        self.assertEqual(module.boundary_group_for(approval_resume), "approval_resume_work")

    def test_boundary_group_splits_monolithic_none_target(self) -> None:
        eval_question = {
            "name": "none-evals-question",
            "label": "none",
            "target": "none",
            "text": "USER:\ncan we have a test or eval mechanism?",
        }
        architecture_question = {
            "name": "none-architecture-question",
            "label": "none",
            "target": "none",
            "text": "USER:\nhow does this become part of the graph query?",
        }

        self.assertEqual(module.boundary_group_for(eval_question), "none_eval_mechanism_question")
        self.assertEqual(module.boundary_group_for(architecture_question), "none_architecture_question")

    def test_boundary_group_splits_none_workflow_questions(self) -> None:
        goal_question = {
            "name": "none-create-goal",
            "label": "none",
            "target": "none",
            "text": "USER:\ncreate a goal that an agent can work toward",
        }
        result_question = {
            "name": "none-results-summary",
            "label": "none",
            "target": "none",
            "text": "USER:\ntell me the results of the experiments",
        }
        eval_question = {
            "name": "none-evals-question",
            "label": "none",
            "target": "none",
            "text": "USER:\ncan we have a test or eval mechanism?",
        }

        self.assertEqual(module.boundary_group_for(goal_question), "none_goal_planning")
        self.assertEqual(module.boundary_group_for(result_question), "none_results_summary")
        self.assertEqual(module.boundary_group_for(eval_question), "none_eval_mechanism_question")

    def test_enrich_rows_adds_source_boundary_and_pair_groups(self) -> None:
        rows = [
            {
                "id": "session-section-chunks/verification-evals-question",
                "name": "verification-evals-question",
                "label": "verification_request",
                "target": "regression_guard",
                "text": "USER:\ncan we have an eval mechanism?",
            },
            {
                "id": "session-section-chunks/verification-regression",
                "name": "verification-regression",
                "label": "verification_request",
                "target": "regression_guard",
                "text": "USER:\nadd a test mechanism",
            },
        ]

        enriched = module.enrich_rows(rows)

        self.assertEqual(enriched[0]["source_group"], "session-section-chunks")
        self.assertEqual(enriched[0]["boundary_group"], "regression_guard")
        self.assertEqual(enriched[0]["pair_group"], "eval_mechanism_boundary")
        self.assertEqual(enriched[1]["pair_group"], "eval_mechanism_boundary")

    def test_enrich_rows_preserves_explicit_source_group(self) -> None:
        rows = [
            {
                "id": "workflow-candidate-topic/surrealml/direction/abc123",
                "suite": "workflow-candidate-topic",
                "name": "surrealml-direction",
                "label": "direction",
                "target": "output_expectation",
                "source_group": "workflow-candidate",
                "text": "USER:\nshow me classifier results",
            }
        ]

        enriched = module.enrich_rows(rows)

        self.assertEqual(enriched[0]["source_group"], "workflow-candidate")
        self.assertEqual(enriched[0]["boundary_group"], "output_expectation")
        self.assertEqual(enriched[0]["pair_group"], "output_expectation::direction")


if __name__ == "__main__":
    unittest.main()
