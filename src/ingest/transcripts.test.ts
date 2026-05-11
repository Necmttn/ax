import { describe, expect, test } from "bun:test";
import { fileRecordKey, toolCallRecordKey, turnRecordKey } from "./record-keys.ts";
import { __testExtractClaudeJsonlLines, claudeConcurrency } from "./transcripts.ts";

describe("Claude transcript extraction", () => {
    test("claudeConcurrency rejects invalid values", () => {
        expect(claudeConcurrency(undefined)).toBe(4);
        expect(claudeConcurrency("8")).toBe(8);
        expect(claudeConcurrency("0")).toBe(4);
        expect(claudeConcurrency("nope")).toBe(4);
    });

    test("extracts tool calls, tool results, skill relations, edits, and TodoWrite snapshots", () => {
        const longOutput = `${"x".repeat(1600)}\nfinal line`;
        const extracted = __testExtractClaudeJsonlLines(
            [
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T10:00:00.000Z",
                    cwd: "/Users/necmttn/Projects/agentctl",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_skill",
                                name: "Skill",
                                input: {
                                    skill: "superpowers:test-driven-development",
                                    reason: "Need TDD",
                                },
                            },
                            {
                                type: "tool_use",
                                id: "toolu_bash",
                                name: "Bash",
                                input: {
                                    command: "cd src && bun test src/ingest/transcripts.test.ts",
                                },
                            },
                            {
                                type: "tool_use",
                                id: "toolu_edit",
                                name: "Edit",
                                input: {
                                    file_path: "src/ingest/transcripts.ts",
                                },
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    type: "user",
                    timestamp: "2026-05-09T10:00:01.000Z",
                    message: {
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "toolu_bash",
                                is_error: true,
                                content: longOutput,
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T10:00:02.000Z",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_todo_1",
                                name: "TodoWrite",
                                input: {
                                    todos: [
                                        {
                                            content: "Inspect schema",
                                            activeForm: "Inspecting schema",
                                            status: "completed",
                                        },
                                        {
                                            content: "Wire writers",
                                            activeForm: "Wiring writers",
                                            status: "in_progress",
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T10:00:03.000Z",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_todo_2",
                                name: "TodoWrite",
                                input: {
                                    todos: [
                                        {
                                            content: "Inspect schema",
                                            activeForm: "Inspecting schema",
                                            status: "completed",
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                }),
            ],
            "-Users-necmttn-Projects-agentctl",
            "session-abc",
        );

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.toolCalls).toHaveLength(5);
        expect(extracted.edits).toEqual([
            {
                session: "session-abc",
                seq: 1,
                ts: "2026-05-09T10:00:00.000Z",
                repo: "agentctl",
                path: "src/ingest/transcripts.ts",
                tool: "Edit",
            },
        ]);

        const skillCall = extracted.toolCalls.find((call) => call.toolName === "Skill");
        expect(skillCall).toMatchObject({
            provider: "claude",
            toolKind: "skill",
            sessionId: "session-abc",
            seq: 1,
            turnKey: turnRecordKey("session-abc", 1),
            callId: "toolu_skill",
            cwd: "/Users/necmttn/Projects/agentctl",
            hasError: false,
        });
        expect(skillCall?.inputJson).toEqual({
            skill: "superpowers:test-driven-development",
            reason: "Need TDD",
        });
        expect(skillCall?.rawJson).toMatchObject({
            type: "tool_use",
            id: "toolu_skill",
            name: "Skill",
        });

        const bashCall = extracted.toolCalls.find((call) => call.toolName === "Bash");
        expect(bashCall).toMatchObject({
            provider: "claude",
            toolKind: "builtin",
            sessionId: "session-abc",
            seq: 1,
            turnKey: turnRecordKey("session-abc", 1),
            callId: "toolu_bash",
            commandText: "cd src && bun test src/ingest/transcripts.test.ts",
            commandToolName: "bun",
            commandNorm: "bun test",
            hasError: true,
        });
        expect(typeof bashCall?.errorText).toBe("string");
        expect(bashCall?.outputJson).toBe(longOutput);
        expect(bashCall?.outputExcerpt?.length).toBeLessThanOrEqual(1200);
        expect(bashCall?.outputExcerpt).toBe(bashCall?.errorText);

        expect(extracted.skillRelations).toEqual([
            {
                toolCallKey: toolCallRecordKey({
                    sessionId: "session-abc",
                    seq: 1,
                    callId: "toolu_skill",
                }),
                skillName: "superpowers:test-driven-development",
                ts: "2026-05-09T10:00:00.000Z",
                reason: "Claude Skill tool invocation",
                labels: { provider: "claude", toolName: "Skill", source: "transcript" },
                metrics: { turnSeq: 1 },
            },
        ]);

        expect(extracted.planSnapshots).toHaveLength(2);
        const [firstSnapshot, secondSnapshot] = extracted.planSnapshots;
        expect(firstSnapshot).toMatchObject({
            sessionId: "session-abc",
            source: "claude_todowrite",
            status: "in_progress",
            createdAt: "2026-05-09T10:00:02.000Z",
            updatedAt: "2026-05-09T10:00:02.000Z",
            ts: "2026-05-09T10:00:02.000Z",
            toolCallKey: toolCallRecordKey({
                sessionId: "session-abc",
                seq: 3,
                callId: "toolu_todo_1",
            }),
        });
        expect(firstSnapshot.items).toEqual([
            expect.objectContaining({
                seq: 1,
                content: "Inspect schema",
                activeForm: "Inspecting schema",
                status: "completed",
            }),
            expect.objectContaining({
                seq: 2,
                content: "Wire writers",
                activeForm: "Wiring writers",
                status: "in_progress",
            }),
        ]);
        expect(secondSnapshot.planKey).toBe(firstSnapshot.planKey);
        expect(secondSnapshot.createdAt).toBe("2026-05-09T10:00:02.000Z");
        expect(secondSnapshot.updatedAt).toBe("2026-05-09T10:00:03.000Z");
        expect(secondSnapshot.snapshotKey).not.toBe(firstSnapshot.snapshotKey);
    });

    test("assigns stable fallback ids to anonymous tool uses in the same turn", () => {
        const extracted = __testExtractClaudeJsonlLines(
            [
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T11:00:00.000Z",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                name: "Bash",
                                input: { command: "pwd" },
                            },
                            {
                                type: "tool_use",
                                name: "Bash",
                                input: { command: "git status --short" },
                            },
                        ],
                    },
                }),
            ],
            "-Users-necmttn-Projects-agentctl",
            "session-anonymous",
        );

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.toolCalls.map((call) => call.callId)).toEqual([
            "anonymous_tool_use_000001_001",
            "anonymous_tool_use_000001_002",
        ]);
        expect(
            new Set(
                extracted.toolCalls.map((call) =>
                    toolCallRecordKey({
                        sessionId: call.sessionId,
                        seq: call.seq,
                        callId: call.callId ?? null,
                    }),
                ),
            ).size,
        ).toBe(2);
    });

    test("turn IDs use centralized turnRecordKey format", () => {
        const extracted = __testExtractClaudeJsonlLines(
            [
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T10:00:00.000Z",
                    cwd: "/Users/necmttn/Projects/agentctl",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_bash",
                                name: "Bash",
                                input: { command: "pwd" },
                            },
                        ],
                    },
                }),
            ],
            "-Users-necmttn-Projects-agentctl",
            "session-id-check",
        );

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        const expectedTurnKey = turnRecordKey("session-id-check", 1);
        const bashCall = extracted.toolCalls.find((c) => c.toolName === "Bash");
        expect(bashCall?.turnKey).toBe(expectedTurnKey);
    });

    test("edited-file IDs use centralized fileRecordKey scoped to repository identity", () => {
        const extracted = __testExtractClaudeJsonlLines(
            [
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T10:00:00.000Z",
                    cwd: "/Users/necmttn/Projects/agentctl",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_edit_check",
                                name: "Edit",
                                input: { file_path: "/Users/necmttn/Projects/agentctl/src/a.ts" },
                            },
                        ],
                    },
                }),
            ],
            "-Users-necmttn-Projects-agentctl",
            "session-file-check",
        );

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        // The repo derived from cwd "/Users/necmttn/Projects/agentctl" is "agentctl"
        // centralized fileRecordKey takes (repositoryKey, path)
        const expectedFileKey = fileRecordKey(
            "agentctl",
            "/Users/necmttn/Projects/agentctl/src/a.ts",
        );
        expect(extracted.edits).toHaveLength(1);
        const edit = extracted.edits[0];
        // Verify the edit record exposes the correct file key via the centralized helper
        // (the key must match what upsertEdits would write to the DB)
        expect(
            fileRecordKey(edit?.repo ?? "_", edit?.path ?? ""),
        ).toBe(expectedFileKey);
    });

    test("keeps TodoWrite plan item keys stable when the same sequence changes", () => {
        const extracted = __testExtractClaudeJsonlLines(
            [
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T12:00:00.000Z",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_todo_1",
                                name: "TodoWrite",
                                input: {
                                    todos: [
                                        {
                                            content: "Inspect failing ingest",
                                            status: "in_progress",
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                }),
                JSON.stringify({
                    type: "assistant",
                    timestamp: "2026-05-09T12:00:01.000Z",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "toolu_todo_2",
                                name: "TodoWrite",
                                input: {
                                    todos: [
                                        {
                                            content: "Fix plan item identity",
                                            status: "in_progress",
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                }),
            ],
            "-Users-necmttn-Projects-agentctl",
            "claude-plan-session",
        );

        expect(extracted).not.toBeNull();
        if (!extracted) return;

        expect(extracted.planSnapshots).toHaveLength(2);
        expect(extracted.planSnapshots[0]?.items[0]?.key).toBe(
            extracted.planSnapshots[1]?.items[0]?.key,
        );
    });
});
