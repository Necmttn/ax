import { describe, expect, test } from "bun:test";
import { formatInsightRows } from "./insights-format.ts";

describe("formatInsightRows", () => {
    test("renders reactions as compact user-to-assistant pairs", () => {
        const output = formatInsightRows("reactions", [
            {
                polarity: "revise",
                signal: "stop_doing",
                ts: "2026-05-29T14:22:49.715Z",
                session: "session:demo",
                user_seq: 12,
                assistant_seq: 10,
                user_text: "we do not need to build storage; use Gists",
                assistant_text: "I recommend building local storage first",
            },
        ]);

        expect(output).toContain("revise / stop_doing");
        expect(output).toContain("user #12: we do not need to build storage; use Gists");
        expect(output).toContain("assistant #10: I recommend building local storage first");
    });

    test("renders failing tools as a compact table, not raw JSON", () => {
        const output = formatInsightRows("tools", [
            { name: "Edit", failure_count: 1057, status_error_count: 1057, last_seen: "2026-06-16T08:52:47.916Z" },
            { name: "write_stdin", exit_code: 1, failure_count: 840, last_seen: "2026-06-11T13:14:03.371Z" },
            { name: "Bash", command_norm: "bun test", exit_code: 2, failure_count: 12, last_seen: "2026-06-10T09:06:05.000Z" },
        ]);

        expect(output).toContain("1. Edit  -  1,057 failures  last 2026-06-16 08:52:47");
        expect(output).toContain("2. write_stdin (exit 1)  -  840 failures");
        expect(output).toContain("3. Bash: bun test (exit 2)  -  12 failures");
        expect(output).not.toContain("status_error_count");
        expect(output).not.toContain("{");
    });

    test("renders empty failing-tools view with a friendly message", () => {
        expect(formatInsightRows("tools", [])).toBe("No failing tools found.");
    });

    test("renders signal summaries without dumping nested JSON", () => {
        const output = formatInsightRows("message-signals", [
            {
                kind: "assistant_behavior",
                label: "verification_claim",
                turns: 2398,
                sessions: 418,
                avg_confidence: 0.74,
                last_seen: "2026-05-29T15:59:41.702Z",
                examples: [{ text: "Verified with bun test." }],
            },
        ]);

        expect(output).toContain("assistant_behavior/verification_claim");
        expect(output).toContain("turns=2398");
        expect(output).toContain("example: Verified with bun test.");
        expect(output).not.toContain("\"examples\"");
    });

    test("renders reaction themes as recurring patterns", () => {
        const output = formatInsightRows("reaction-themes", [
            {
                kind: "correction",
                label: "stop_doing",
                reactions: 6,
                sessions: 6,
                revise: 6,
                accept: 0,
                reject: 0,
                canonical_text: "User tells the agent to stop a behavior.",
                examples: [{
                    polarity: "revise",
                    user_text: "we do not need to build storage",
                    assistant_text: "I recommend building local storage",
                }],
            },
        ]);

        expect(output).toContain("correction/stop_doing");
        expect(output).toContain("reactions=6");
        expect(output).toContain("revise=6");
        expect(output).toContain("user: we do not need to build storage");
        expect(output).toContain("assistant: I recommend building local storage");
    });

    test("renders classifier facts with previous assistant and tool failure context", () => {
        const output = formatInsightRows("classifier-facts", [
            {
                classifier_key: "direction-event",
                label: "direction",
                target: "tooling_preference",
                durability: "repo_preference",
                confidence: 0.88,
                ts: "2026-05-30T10:15:00.000Z",
                user_seq: 12,
                user_text: "can you use UV ?",
                previous_assistant: {
                    seq: 10,
                    text: "pip is failing to resolve these packages.",
                },
                recent_tool_failures: [{
                    name: "Bash",
                    command_norm: "pip install sklearn",
                    error_text: "dependency resolution failed",
                }],
                signals: "[\"uv\",\"pip failure\"]",
            },
        ]);

        expect(output).toContain("direction-event / direction / tooling_preference");
        expect(output).toContain("confidence=0.88");
        expect(output).toContain("user #12: can you use UV ?");
        expect(output).toContain("previous assistant #10: pip is failing");
        expect(output).toContain("recent failure: pip install sklearn");
        expect(output).not.toContain("\"previous_assistant\"");
    });

    test("renders correction contexts around the causing assistant turn", () => {
        const output = formatInsightRows("correction-contexts", [
            {
                target: "missing_context",
                durability: "candidate_guidance",
                ts: "2026-05-30T10:20:00.000Z",
                user_seq: 18,
                user_text: "that was a correction, you ignored the previous context",
                previous_assistant: {
                    seq: 16,
                    text: "I treated this as a fresh package request.",
                },
                recent_tool_failures: [
                    { name: "Bash", command_norm: "python -m pip install x" },
                    { name: "Bash", error_text: "module not found" },
                ],
                evidence_json: "{\"rule\":\"missing previous context\"}",
            },
        ]);

        expect(output).toContain("missing_context / candidate_guidance");
        expect(output).toContain("correction #18: that was a correction");
        expect(output).toContain("caused by assistant #16");
        expect(output).toContain("failed tools: python -m pip install x; module not found");
    });

    test("renders classifier outcomes after the classified fact", () => {
        const output = formatInsightRows("classifier-outcomes", [
            {
                classifier_key: "verification-event",
                label: "verification_request",
                target: "test_required",
                ts: "2026-05-30T10:25:00.000Z",
                user_seq: 20,
                user_text: "did you run tests?",
                later_tool_calls: [
                    {
                        name: "Bash",
                        command_norm: "bun test src/classifiers/service.test.ts",
                        has_error: false,
                    },
                ],
                later_command_outcomes: [
                    {
                        kind: "success",
                        status: "passed",
                        command_norm: "bun test src/classifiers/service.test.ts",
                    },
                ],
                later_user_turns: [
                    {
                        seq: 22,
                        text: "ok continue",
                    },
                ],
            },
        ]);

        expect(output).toContain("verification-event / verification_request / test_required");
        expect(output).toContain("fact #20: did you run tests?");
        expect(output).toContain("next tool: bun test src/classifiers/service.test.ts");
        expect(output).toContain("outcome: success / passed");
        expect(output).toContain("later user #22: ok continue");
    });

    test("renders harness candidates as proposed layer actions with evidence", () => {
        const output = formatInsightRows("harness-candidates", [
            {
                candidate_id: ["classifier_harness_candidate", "verification-event", "verification_request", "test_required", "candidate_guidance"],
                dedupe_signature: ["verification-event", "verification_request", "test_required", "candidate_guidance"],
                classifier_key: "verification-event",
                label: "verification_request",
                target: "test_required",
                durability: "candidate_guidance",
                facts: 7,
                sessions: 4,
                avg_confidence: 0.91,
                proposed_layer: "verification",
                proposed_action: "add_verification_gate",
                examples: [
                    {
                        user_seq: 20,
                        user_text: "did you run tests?",
                    },
                ],
                evidence: [
                    { kind: "previous_assistant", evidence: "turn:abc" },
                    { kind: "recent_tool_failure", evidence: "tool_call:def" },
                ],
            },
        ]);

        expect(output).toContain("verification -> add_verification_gate");
        expect(output).toContain("facts=7");
        expect(output).toContain("id: classifier_harness_candidate/verification-event/verification_request/test_required/candidate_guidance");
        expect(output).toContain("signature: verification-event/verification_request/test_required/candidate_guidance");
        expect(output).toContain("example #20: did you run tests?");
        expect(output).toContain("evidence refs: 2");
    });
});
