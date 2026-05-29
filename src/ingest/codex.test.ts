import { describe, expect, test } from "bun:test";
import { agentEventRecordKey } from "./provider-events.ts";
import { toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import {
    __testBuildCodexBatchStatements,
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

    test("extracts input_text messages and classifies user task and context turns", () => {
        const longTaskText = `Trace the user prompt ingestion path.\n${"y".repeat(620)}`;
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-user-text",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "message",
                    role: "developer",
                    content: [
                        {
                            type: "input_text",
                            text: "<permissions instructions>\nFilesystem sandboxing is read-only.",
                        },
                    ],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
                        },
                    ],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:03.000Z",
                payload: {
                    type: "message",
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: longTaskText,
                        },
                    ],
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(
            extracted.turns.map((turn) => ({
                role: turn.role,
                text: turn.text,
                text_excerpt: turn.text_excerpt,
                message_kind: turn.message_kind,
                intent_kind: turn.intent_kind,
            })),
        ).toEqual([
            {
                role: "developer",
                text: "<permissions instructions>\nFilesystem sandboxing is read-only.",
                text_excerpt: "<permissions instructions>\nFilesystem sandboxing is read-only.",
                message_kind: "system_or_developer",
                intent_kind: "system_context",
            },
            {
                role: "user",
                text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
                text_excerpt: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
                message_kind: "context",
                intent_kind: "system_context",
            },
            {
                role: "user",
                text: longTaskText,
                text_excerpt: longTaskText.slice(0, 500),
                message_kind: "task",
                intent_kind: "organic_task",
            },
        ]);
        expect(extracted.providerEvents.map((event) => ({
            provider: event.provider,
            providerSessionId: event.providerSessionId,
            seq: event.seq,
            type: event.type,
            role: event.role,
            textExcerpt: event.textExcerpt,
        }))).toEqual([
            {
                provider: "codex",
                providerSessionId: "codex-user-text",
                seq: 1,
                type: "message",
                role: "developer",
                textExcerpt: "<permissions instructions>\nFilesystem sandboxing is read-only.",
            },
            {
                provider: "codex",
                providerSessionId: "codex-user-text",
                seq: 2,
                type: "message",
                role: "user",
                textExcerpt: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>Use Bun.</INSTRUCTIONS>",
            },
            {
                provider: "codex",
                providerSessionId: "codex-user-text",
                seq: 3,
                type: "message",
                role: "user",
                textExcerpt: longTaskText.slice(0, 500),
            },
        ]);
    });

    test("links adjacent provider events with linear parent edges while preserving tool-result parents", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T12:00:00.000Z",
                payload: {
                    id: "codex-linear",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T12:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:00:01.000Z",
                payload: {
                    type: "message",
                    id: "msg-user",
                    role: "user",
                    content: [{ type: "input_text", text: "Run a command." }],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:00:02.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call-linear",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:00:03.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call-linear",
                    output: "ok",
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            parentProviderEventId: event.parentProviderEventId,
            parentProviderEventIds: event.parentProviderEventIds,
        }))).toEqual([
            {
                providerEventId: "msg-user",
                parentProviderEventId: undefined,
                parentProviderEventIds: undefined,
            },
            {
                providerEventId: "call-linear",
                parentProviderEventId: "msg-user",
                parentProviderEventIds: undefined,
            },
            {
                providerEventId: "function_call_output:call-linear",
                parentProviderEventId: "call-linear",
                parentProviderEventIds: undefined,
            },
        ]);
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
                    cwd: "/Users/necmttn/Projects/ax",
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
                        workdir: "/Users/necmttn/Projects/ax",
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
                    workdir: "/Users/necmttn/Projects/ax",
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
            cwd: "/Users/necmttn/Projects/ax",
            inputJson: {
                cmd: "git status --short",
                workdir: "/Users/necmttn/Projects/ax",
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
        expect(execCall?.agentEventKey).toBe(agentEventRecordKey({
            provider: "codex",
            providerSessionId: "codex-session",
            providerEventId: "call_exec",
            seq: 1,
        }));
        expect(extracted.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            seq: event.seq,
            type: event.type,
            role: event.role,
            textExcerpt: event.textExcerpt,
        }))).toEqual([
            {
                providerEventId: "call_exec",
                seq: 1,
                type: "function_call",
                role: "tool_call",
                textExcerpt: null,
            },
            {
                providerEventId: "function_call_output:call_exec",
                seq: 2,
                type: "function_call_output",
                role: "function_call_output",
                textExcerpt: "fatal: not a git repository",
            },
            {
                providerEventId: "call_plan",
                seq: 3,
                type: "function_call",
                role: "tool_call",
                textExcerpt: null,
            },
        ]);

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

    test("bounds large function output provider event payloads", () => {
        const largeOutputBody = "z".repeat(5000);
        const largeOutput = [
            "Chunk ID: large",
            "Wall time: 0.1000 seconds",
            "Process exited with code 0",
            "Output:",
            largeOutputBody,
        ].join("\n");
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-large-output",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T10:00:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:01.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call_large",
                    arguments: JSON.stringify({ cmd: "printf large" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T10:00:02.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call_large",
                    output: largeOutput,
                },
            }),
        ]);

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const outputEvent = extracted.providerEvents.find(
            (event) => event.type === "function_call_output",
        );
        expect(outputEvent).toBeDefined();
        if (!outputEvent) return;

        expect(outputEvent.text).toHaveLength(1200);
        expect(outputEvent.text).toBe(outputEvent.textExcerpt);
        expect(outputEvent.text).not.toBe(largeOutput);
        const raw = outputEvent.raw as { output?: unknown };
        expect(raw).toMatchObject({
            type: "function_call_output",
            call_id: "call_large",
        });

        expect(raw.output).toMatchObject({
            truncated: true,
            bytes: expect.any(Number),
        });
        const compactedOutput = raw.output as { excerpt?: unknown };
        expect(typeof compactedOutput.excerpt).toBe("string");
        if (typeof compactedOutput.excerpt === "string") {
            expect(compactedOutput.excerpt.length).toBeLessThan(largeOutput.length);
        }
    });

    test("streaming extraction drains completed tool calls after their output arrives", () => {
        const batches = __testStreamCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-stream-session",
                    cwd: "/Users/necmttn/Projects/ax",
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
                    output: "Chunk ID: one\nProcess exited with code 0\nOutput:\n/Users/necmttn/Projects/ax\n",
                },
            }),
        ], 2);

        expect(batches).toHaveLength(3);
        expect(batches[0]?.turns).toHaveLength(1);
        expect(batches[0]?.toolCalls).toHaveLength(0);
        expect(batches[1]?.turns).toHaveLength(2);
        expect(batches[1]?.toolCalls.map((call) => call.callId)).toEqual(["call_one"]);
        expect(batches[1]?.toolCalls[0]?.outputExcerpt).toBe("/Users/necmttn/Projects/ax");
        expect(batches[2]?.turns).toHaveLength(0);
        expect(batches[2]?.toolCalls.map((call) => call.callId)).toEqual(["call_two"]);
        expect(batches[2]?.toolCalls[0]?.outputExcerpt).toBeUndefined();
    });

    test("streaming extraction preserves parent edges when parent event flushed in an earlier batch", () => {
        const batches = __testStreamCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T12:30:00.000Z",
                payload: {
                    id: "codex-stream-parent",
                    cwd: "/Users/necmttn/Projects/ax",
                    timestamp: "2026-05-09T12:30:00.000Z",
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:30:01.000Z",
                payload: {
                    type: "message",
                    id: "msg-before-flush",
                    role: "user",
                    content: [{ type: "input_text", text: "Run pwd." }],
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:30:02.000Z",
                payload: {
                    type: "function_call",
                    name: "exec_command",
                    call_id: "call-after-flush",
                    arguments: JSON.stringify({ cmd: "pwd" }),
                },
            }),
            JSON.stringify({
                type: "response_item",
                timestamp: "2026-05-09T12:30:03.000Z",
                payload: {
                    type: "function_call_output",
                    call_id: "call-after-flush",
                    output: "Chunk ID: out\nProcess exited with code 0\nOutput:\n/tmp\n",
                },
            }),
        ], 2);

        expect(batches).toHaveLength(2);
        expect(batches[0]?.providerEvents.map((event) => event.providerEventId)).toEqual(["msg-before-flush"]);
        expect(batches[1]?.providerEvents.map((event) => ({
            providerEventId: event.providerEventId,
            parentProviderEventId: event.parentProviderEventId,
        }))).toEqual([
            {
                providerEventId: "call-after-flush",
                parentProviderEventId: "msg-before-flush",
            },
            {
                providerEventId: "function_call_output:call-after-flush",
                parentProviderEventId: "call-after-flush",
            },
        ]);

        const secondBatchSql = __testBuildCodexBatchStatements(batches[1]!, 1200).join("\n");
        const parentKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "codex-stream-parent",
            providerEventId: "msg-before-flush",
            seq: 1,
        });
        const childKey = agentEventRecordKey({
            provider: "codex",
            providerSessionId: "codex-stream-parent",
            providerEventId: "call-after-flush",
            seq: 2,
        });

        expect(secondBatchSql).not.toContain(`UPSERT agent_event:\`${parentKey}\``);
        expect(secondBatchSql).toContain(`RELATE agent_event:\`${parentKey}\`->agent_event_child:`);
        expect(secondBatchSql).toContain(`->agent_event:\`${childKey}\``);
    });

    test("turn IDs use centralized turnRecordKey format", () => {
        const extracted = __testExtractCodexJsonlLines([
            JSON.stringify({
                type: "session_meta",
                timestamp: "2026-05-09T10:00:00.000Z",
                payload: {
                    id: "codex-id-check",
                    cwd: "/Users/necmttn/Projects/ax",
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
                    cwd: "/Users/necmttn/Projects/ax",
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
