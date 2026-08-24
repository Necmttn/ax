import importlib.util
import json
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("workflow_candidate_report.py")
spec = importlib.util.spec_from_file_location("workflow_candidate_report", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules["workflow_candidate_report"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


def group(graph_id: str, label: str, action: str, support: int) -> dict:
    return {
        "graph_id": graph_id,
        "label": label,
        "properties_json": json.dumps({
            "classifier_key": label.split(":")[0],
            "label": label.split(":")[1],
            "target": label.split(":")[2],
            "proposed_action": action,
            "support_count": support,
        }),
    }


def evidence(subject: str, result_id: str, confidence: float, text: str, wrapper_like: bool = False) -> dict:
    return {
        "graph_id": f"fact:{result_id}",
        "subject": subject,
        "object": f"classifier_result_ref:{result_id}",
        "properties_json": json.dumps({
            "result_id": result_id,
            "confidence": confidence,
            "turn": f"turn:{result_id}",
            "text_excerpt": text,
            "wrapper_like": wrapper_like,
        }),
    }


class WorkflowCandidateReportTest(unittest.TestCase):
    def test_build_report_ranks_candidates_and_includes_examples(self) -> None:
        report = module.build_report(
            [
                group("g-verify", "reaction-event:direction:verification", "add_verification_gate", 10),
                group("g-approval", "reaction-event:approval:unknown", "record_approval_checkpoint", 8),
            ],
            [
                evidence("g-verify", "v1", 0.9, "run the tests"),
                evidence("g-verify", "v2", 0.8, "show proof"),
                evidence("g-approval", "a1", 0.82, "ship it"),
            ],
            "transcript_classifier_projection",
            2,
            1,
        )

        self.assertEqual(report["decision"], "workflow_candidates_ranked")
        self.assertEqual(report["candidates"][0]["group_id"], "g-verify")
        self.assertEqual(report["candidates"][0]["examples"][0]["text_excerpt"], "run the tests")
        self.assertEqual(report["totals"]["candidate_group_count"], 2)

    def test_build_report_flags_wrapper_like_evidence(self) -> None:
        report = module.build_report(
            [group("g", "reaction-event:direction:verification", "add_verification_gate", 1)],
            [evidence("g", "w", 0.8, "<subagent_notification>{}", True)],
            "transcript_classifier_projection",
            10,
            3,
        )

        self.assertEqual(report["decision"], "needs_workflow_candidate_review")
        self.assertIn("candidate evidence includes wrapper-like turns", report["failures"])

    def test_build_report_tracks_task_like_evidence_and_penalizes_score(self) -> None:
        report = module.build_report(
            [group("g", "reaction-event:direction:verification", "add_verification_gate", 2)],
            [
                evidence("g", "task", 0.8, "You are implementing Task 4 in a worktree"),
                evidence("g", "organic", 0.8, "did you run the tests?"),
            ],
            "transcript_classifier_projection",
            10,
            3,
        )

        candidate = report["candidates"][0]
        self.assertEqual(candidate["task_like_count"], 1)
        self.assertEqual(candidate["examples"][0]["task_like"], True)
        self.assertLess(
            candidate["score"],
            module.candidate_score(2, 2, 0.8, "add_verification_gate"),
        )

    def test_compact_text_truncates_long_excerpts(self) -> None:
        self.assertTrue(module.compact_text("x" * 300, 20).endswith("..."))


if __name__ == "__main__":
    unittest.main()
