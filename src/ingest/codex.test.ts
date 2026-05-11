import { describe, expect, test } from "bun:test";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import {
    __testCompactCodexToolCall,
    __testExtractCodexJsonlLines,
    __testStreamCodexJsonlLines,
    codexConcurrency,
    codexFlushEvery,
    codexPayloadMaxBytes,
    codexProgressEvery,
    shouldSnapshotCodexRaw,
} from "./codex.ts";

describe("Codex transcript extraction", () => {
    test("skips oversized raw artifact snapshots", () => {
        expect(shouldSnapshotCodexRaw(1024, 1024)).toBe(true);
        expect(shouldSnapshotCodexRaw(1025, 1024)).toBe(false);
    });

    test("codexProgressEvery rejects invalid values", () => {
        expect(codexProgressEvery(undefined)).toBe(10);
        expect(codexProgressEvery("5")).toBe(5);
        expect(codexProgressEvery("0")).toBe(10);
        expect(codexProgressEvery("nope")).toBe(10);
    });

    test("codexFlushEvery rejects invalid values", () => {
        expect(codexFlushEvery(undefined)).toBe(500);
        expect(codexFlushEvery("1000")).toBe(1000);
        expect(codexFlushEvery("0")).toBe(500);
        expect(codexFlushEvery("nope")).toBe(500);
    });

    test("codexConcurrency rejects invalid values", () => {
        expect(codexConcurrency(undefined)).toBe(1);
        expect(codexConcurrency("3")).toBe(3);
        expect(codexConcurrency("0")).toBe(1);
        expect(codexConcurrency("nope")).toBe(1);
    });

    test("codexPayloadMaxBytes rejects invalid values", () => {
        expect(codexPayloadMaxBytes(undefined)).toBe(1200);
        expect(codexPayloadMaxBytes("0")).toBe(0);
        expect(codexPayloadMaxBytes("4096")).toBe(4096);
        expect(codexPayloadMaxBytes("-1")).toBe(1200);
        expect(codexPayloadMaxBytes("nope")).toBe(1200);
    });

    test("compacts oversized Codex tool call payloads for storage", () => {
        const compacted = __testCompactCodexToolCall({
            provider: "codex",
            toolName: "exec_command",
            toolKind: "builtin",
            sessionId: "session-1",
            seq: 1,
            turnKey: turnRecordKey("session-1", 1),
            callId: "call-1",
            ts: "2026-05-09T10:00:01.000Z",
            cwd: "/tmp/project",
            inputJson: { cmd: "printf hello" },
            outputJson: "x".repeat(2000),
            rawJson: {
                type: "function_call",
                name: "exec_command",
                call_id: "call-1",
                arguments: "x".repeat(2000),
            },
            outputExcerpt: "hello",
            hasError: false,
        }, 64);

        expect(compacted.inputJson).toEqual({ cmd: "printf hello" });
        expect(compacted.outputJson).toMatchObject({
            truncated: true,
            bytes: expect.any(Number),
            excerpt: expect.stringContaining("x"),
        });
        expect(compacted.rawJson).toMatchObject({
            truncated: true,
            bytes: expect.any(Number),
            type: "function_call",
            name: "exec_command",
            call_id: "call-1",
        });
        expect(compacted.outputExcerpt).toBe("hello");
    });

    test("extracts function calls, matched outputs, synthetic skill relations, and update_plan snapshots", () => {
        const execOutput =
            "Chunk ID: abc\nWall time: 0.2000 seconds\nProcess exited with code 1\nOriginal token count: 30\nOutput:\nfatal: not a git repository\n";
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-session",
                    cwd: "/Users/necmttn/Projects/agentctl",
                    cli_version: "0.1.0",
                    model_provider: "openai",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_exec",
                    arguments: JSON.stringify({
                        cmd: "git status --short",
                        workdir: "/Users/necmttn/Projects/agentctl",
                    }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call_exec",
                    output: execOutput,
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:03.000Z",
                payload: {
                    type: "function_call",
                    name: "update_plan",
                    call_id: "call_plan",
                    arguments: JSON.stringify({
                        explanation: "Tracking task progress.",
                        plan: [
                            { step: "Inspect Codex ingestion", status: "completed" },
                            { step: "Write evidence graph records", status: "in_progress" },
                        ],
                    }),
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.turns.map((turn) => [turn.seq, turn.role, turn.has_tool_use])).toEqual([
            [1, "tool_call", true],
            [2, "function_call_output", false],
            [3, "tool_call", true],
        ]);

        expect(extracted.invocations).toEqual([
            {
                session: "codex-session",
                seq: 1,
                ts: "2026-05-09T10:00:01.000Z",
                skill: "codex:exec_command",
                args: JSON.stringify({
                    cmd: "git status --short",
                    workdir: "/Users/necmttn/Projects/agentctl",
                }),
            },
            {
                session: "codex-session",
                seq: 3,
                ts: "2026-05-09T10:00:03.000Z",
                skill: "codex:update_plan",
                args: JSON.stringify({
                    explanation: "Tracking task progress.",
                    plan: [
                        { step: "Inspect Codex ingestion", status: "completed" },
                        { step: "Write evidence graph records", status: "in_progress" },
                    ],
                }),
            },
        ]);

        expect(extracted.toolCalls).toHaveLength(2);
        const execCall = extracted.toolCalls.find((call) => call.toolName === "exec_command");
        expect(execCall).toMatchObject({
            provider: "codex",
            toolKind: "builtin",
            sessionId: "codex-session",
            seq: 1,
            turnKey: turnRecordKey("codex-session", 1),
            callId: "call_exec",
            ts: "2026-05-09T10:00:01.000Z",
            cwd: "/Users/necmttn/Projects/agentctl",
            inputJson: {
                cmd: "git status --short",
                workdir: "/Users/necmttn/Projects/agentctl",
            },
            commandText: "git status --short",
            commandToolName: "git",
            commandNorm: "git status",
            outputJson: execOutput,
            outputExcerpt: "fatal: not a git repository",
            errorText: "fatal: not a git repository",
            exitCode: 1,
            durationMs: 200,
            hasError: true,
        });
        expect(execCall?.rawJson).toMatchObject({
            type: "function_call",
            name: "exec_command",
            call_id: "call_exec",
        });

        const updatePlanKey = toolCallRecordKey({
            sessionId: "codex-session",
            seq: 3,
            callId: "call_plan",
        });
        expect(extracted.skillRelations).toEqual([
            {
                toolCallKey: toolCallRecordKey({
                    sessionId: "codex-session",
                    seq: 1,
                    callId: "call_exec",
                }),
                skillName: "codex:exec_command",
                ts: "2026-05-09T10:00:01.000Z",
                reason: "Codex function call",
                labels: {
                    provider: "codex",
                    toolName: "exec_command",
                    source: "transcript",
                },
                metrics: { turnSeq: 1 },
            },
            {
                toolCallKey: updatePlanKey,
                skillName: "codex:update_plan",
                ts: "2026-05-09T10:00:03.000Z",
                reason: "Codex function call",
                labels: {
                    provider: "codex",
                    toolName: "update_plan",
                    source: "transcript",
                },
                metrics: { turnSeq: 3 },
            },
        ]);

        expect(extracted.planSnapshots).toHaveLength(1);
        expect(extracted.planSnapshots[0]).toMatchObject({
            sessionId: "codex-session",
            source: "codex_update_plan",
            status: "in_progress",
            createdAt: "2026-05-09T10:00:03.000Z",
            updatedAt: "2026-05-09T10:00:03.000Z",
            ts: "2026-05-09T10:00:03.000Z",
            toolCallKey: updatePlanKey,
            explanation: "Tracking task progress.",
        });
        expect(extracted.planSnapshots[0]?.items).toEqual([
            expect.objectContaining({
                seq: 1,
                content: "Inspect Codex ingestion",
                activeForm: null,
                status: "completed",
            }),
            expect.objectContaining({
                seq: 2,
                content: "Write evidence graph records",
                activeForm: null,
                status: "in_progress",
            }),
        ]);
    });

    test("streaming extraction drains completed tool calls after their output arrives", () => {
        const batches = __testStreamCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-stream-session",
                    cwd: "/Users/necmttn/Projects/agentctl",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_one",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_two",
                    arguments: JSON.stringify({ cmd: "git status --short" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:03.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call_one",
                    output: "Chunk ID: one\nProcess exited with code 0\nOutput:\n/Users/necmttn/Projects/agentctl\n",
                },
            }),
        ], 2);

        expect(batches).toHaveLength(3);
        expect(batches[0]?.turns).toHaveLength(1);
        expect(batches[0]?.toolCalls).toHaveLength(0);
        expect(batches[1]?.turns).toHaveLength(2);
        expect(batches[1]?.toolCalls.map((call) => call.callId)).toEqual(["call_one"]);
        expect(batches[1]?.toolCalls[0]?.outputExcerpt).toBe("/Users/necmttn/Projects/agentctl");
        expect(batches[2]?.turns).toHaveLength(0);
        expect(batches[2]?.toolCalls.map((call) => call.callId)).toEqual(["call_two"]);
        expect(batches[2]?.toolCalls[0]?.outputExcerpt).toBeUndefined();
    });

    test("turn IDs use centralized turnRecordKey format", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-id-check",
                    cwd: "/Users/necmttn/Projects/agentctl",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_check",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const expectedTurnKey = turnRecordKey("codex-id-check", 1);
        const execCall = extracted.toolCalls.find((c) => c.toolName === "exec_command");
        expect(execCall?.turnKey).toBe(expectedTurnKey);
    });

    test("keeps plan item keys stable when the same step sequence changes", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-plan-session",
                    cwd: "/Users/necmttn/Projects/agentctl",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "update_plan",
                    call_id: "call_plan_1",
                    arguments: JSON.stringify({
                        plan: [{ step: "Inspect failing ingest", status: "in_progress" }],
                    }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call",
                    name: "update_plan",
                    call_id: "call_plan_2",
                    arguments: JSON.stringify({
                        plan: [{ step: "Fix plan item identity", status: "in_progress" }],
                    }),
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.planSnapshots).toHaveLength(2);
        expect(extracted.planSnapshots[0]?.items[0]?.key).toBe(
            extracted.planSnapshots[1]?.items[0]?.key,
        );
    });
});
