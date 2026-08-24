#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("strict_none_gate.py")
spec = importlib.util.spec_from_file_location("session_section_strict_none_gate", SCRIPT_PATH)
module = importlib.util.module_from_spec(spec)
sys.modules["session_section_strict_none_gate"] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class StrictNoneGateTest(unittest.TestCase):
    def test_catches_agents_instruction_context_dump(self) -> None:
        row = {"text": "USER:\n# AGENTS.md instructions for /repo <INSTRUCTIONS> use bun"}

        self.assertEqual(module.strict_none_reason(row), "context_dump_gate")

    def test_catches_delegated_task_context_dump(self) -> None:
        row = {"text": "USER:\nYou are implementing Task 5 from the approved plan. Files you own: src/x.ts"}

        self.assertEqual(module.strict_none_reason(row), "delegated_task_context_gate")

    def test_catches_merge_status_control_turn(self) -> None:
        row = {"text": "USER:\ncan I merge this or is there still something missing?"}

        self.assertEqual(module.strict_none_reason(row), "workflow_control_gate")

    def test_does_not_catch_real_dev_environment_preference(self) -> None:
        row = {"text": "USER:\nuse docker compose for surrealdb so local dev is predictable"}

        self.assertIsNone(module.strict_none_reason(row))

    def test_apply_strict_none_gate_records_overrides(self) -> None:
        examples = [
            {"id": "a", "actual": "none", "predicted": "environment_or_preference_signal"},
            {"id": "b", "actual": "environment_or_preference_signal", "predicted": "environment_or_preference_signal"},
        ]
        rows = {
            "a": {"text": "USER:\n# AGENTS.md instructions <INSTRUCTIONS>"},
            "b": {"text": "USER:\nuse docker compose for surrealdb"},
        }

        predictions, overrides = module.apply_strict_none_gate(examples, rows)

        self.assertEqual(predictions, ["none", "environment_or_preference_signal"])
        self.assertEqual(overrides, [{"id": "a", "reason": "context_dump_gate"}])


if __name__ == "__main__":
    unittest.main()
