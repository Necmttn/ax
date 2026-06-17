import { describe, expect, test } from "bun:test";
import {
    normalizeClaudeTaskCreate,
    normalizeClaudeTaskUpdate,
    normalizeClaudeTodoWrite,
    normalizeCodexUpdatePlan,
    normalizeProviderPlanSnapshot,
    providerPlanSignalAvailability,
    toPlanSnapshotWrite,
} from "./plans.ts";

describe("plan normalization", () => {
    test("normalizes Claude TodoWrite snapshot", () => {
        const snapshot = normalizeClaudeTodoWrite({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: {
                todos: [
                    { content: "Inspect schema", activeForm: "Inspecting schema", status: "completed" },
                    { content: "Add tests", activeForm: "Adding tests", status: "in_progress" },
                ],
            },
        });

        expect(snapshot.source).toBe("claude_todowrite");
        expect(snapshot.provider).toBe("claude");
        expect(snapshot.items).toEqual([
            { externalId: null, seq: 1, content: "Inspect schema", activeForm: "Inspecting schema", status: "completed" },
            { externalId: null, seq: 2, content: "Add tests", activeForm: "Adding tests", status: "in_progress" },
        ]);
    });

    test("normalizes Claude TaskCreate snapshot", () => {
        const snapshot = normalizeClaudeTaskCreate({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: {
                subject: "Inspect task tools",
                description: "Read Claude task tool payloads",
                activeForm: "Inspecting task tools",
            },
        });

        expect(snapshot.source).toBe("claude_task");
        expect(snapshot.provider).toBe("claude");
        expect(snapshot.explanation).toBe("TaskCreate");
        expect(snapshot.items).toEqual([
            {
                externalId: null,
                seq: 1,
                content: "Inspect task tools",
                activeForm: "Inspecting task tools",
                status: "pending",
            },
        ]);
    });

    test("normalizes Claude TaskCreate identity from tool result task", () => {
        const snapshot = normalizeClaudeTaskCreate({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: {
                subject: "Inspect task tools",
                activeForm: "Inspecting task tools",
                toolUseResult: {
                    task: {
                        id: "task-created",
                        status: "active",
                    },
                },
            },
        });

        expect(snapshot.items).toEqual([
            {
                externalId: "task-created",
                seq: 1,
                content: "Inspect task tools",
                activeForm: "Inspecting task tools",
                status: "in_progress",
            },
        ]);
    });

    test("normalizes Claude TaskUpdate snapshot", () => {
        const snapshot = normalizeClaudeTaskUpdate({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: JSON.stringify({
                task_id: "task-123",
                description: "Patch task plan snapshots",
                active_form: "Patching task plan snapshots",
                status: "in_progress",
            }),
        });

        expect(snapshot.source).toBe("claude_task");
        expect(snapshot.provider).toBe("claude");
        expect(snapshot.explanation).toBe("TaskUpdate");
        expect(snapshot.items).toEqual([
            {
                externalId: "task-123",
                seq: 1,
                content: "Patch task plan snapshots",
                activeForm: "Patching task plan snapshots",
                status: "in_progress",
            },
        ]);
    });

    test("normalizes Claude Task aliases using first non-empty value", () => {
        expect(
            normalizeClaudeTaskCreate({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    subject: "Alias task",
                    activeForm: "  ",
                    active_form: "Using alias",
                },
            }).items[0]?.activeForm,
        ).toBe("Using alias");

        expect(
            normalizeClaudeTaskUpdate({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    taskId: " ",
                    id: "",
                    task_id: "task-alias",
                    activeForm: "",
                    active_form: "Updating alias",
                    status: "completed",
                },
            }).items,
        ).toEqual([
            {
                externalId: "task-alias",
                seq: 1,
                content: "task-alias",
                activeForm: "Updating alias",
                status: "completed",
            },
        ]);
    });

    test("maps Claude TaskUpdate deleted status to abandoned", () => {
        expect(
            normalizeClaudeTaskUpdate({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    id: "task-deleted",
                    subject: "Remove stale plan item",
                    status: "deleted",
                },
            }).items,
        ).toEqual([
            {
                externalId: "task-deleted",
                seq: 1,
                content: "Remove stale plan item",
                activeForm: null,
                status: "abandoned",
            },
        ]);
    });

    test("maps Claude Task active status to in_progress", () => {
        expect(
            normalizeClaudeTaskUpdate({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    id: "task-active",
                    subject: "Keep current task visible",
                    status: "active",
                },
            }).items,
        ).toEqual([
            {
                externalId: "task-active",
                seq: 1,
                content: "Keep current task visible",
                activeForm: null,
                status: "in_progress",
            },
        ]);
    });

    test("normalizes Codex update_plan snapshot", () => {
        const snapshot = normalizeCodexUpdatePlan({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: {
                explanation: "Following the plan gate.",
                plan: [
                    { step: "Inspect files", status: "completed" },
                    { step: "Patch schema", status: "pending" },
                ],
            },
        });

        expect(snapshot.source).toBe("codex_update_plan");
        expect(snapshot.provider).toBe("codex");
        expect(snapshot.explanation).toBe("Following the plan gate.");
        expect(snapshot.items[1]).toEqual({
            externalId: null,
            seq: 2,
            content: "Patch schema",
            activeForm: null,
            status: "pending",
        });
    });

    test("normalizes Codex update_plan arguments from transcript JSON string", () => {
        const snapshot = normalizeCodexUpdatePlan({
            sessionId: "s1",
            ts: "2026-05-09T10:00:00.000Z",
            input: JSON.stringify({
                explanation: "Transcript payload.",
                plan: [
                    { step: "Read transcript", status: "completed" },
                    { step: "Write evidence", status: "in_progress" },
                ],
            }),
        });

        expect(snapshot.explanation).toBe("Transcript payload.");
        expect(snapshot.items).toEqual([
            {
                externalId: null,
                seq: 1,
                content: "Read transcript",
                activeForm: null,
                status: "completed",
            },
            {
                externalId: null,
                seq: 2,
                content: "Write evidence",
                activeForm: null,
                status: "in_progress",
            },
        ]);
    });

    test("provider-neutral detector dispatches Claude and Codex plan tools", () => {
        expect(
            normalizeProviderPlanSnapshot({
                provider: "claude",
                toolName: "TodoWrite",
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: { todos: [{ content: "Use shared contract", status: "in_progress" }] },
            }),
        ).toMatchObject({
            provider: "claude",
            source: "claude_todowrite",
            items: [{ content: "Use shared contract", status: "in_progress" }],
        });

        expect(
            normalizeProviderPlanSnapshot({
                provider: "claude",
                toolName: "TaskCreate",
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: { subject: "Create task item" },
            }),
        ).toMatchObject({
            provider: "claude",
            source: "claude_task",
            explanation: "TaskCreate",
            items: [{ content: "Create task item", status: "pending" }],
        });

        expect(
            normalizeProviderPlanSnapshot({
                provider: "claude",
                toolName: "TaskUpdate",
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: { taskId: "task-abc", status: "completed" },
            }),
        ).toMatchObject({
            provider: "claude",
            source: "claude_task",
            explanation: "TaskUpdate",
            items: [{ externalId: "task-abc", content: "task-abc", status: "completed" }],
        });

        expect(
            normalizeProviderPlanSnapshot({
                provider: "claude",
                toolName: "TaskGet",
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    toolUseResult: {
                        task: {
                            id: "task-get",
                            subject: "Read task state",
                            active_form: "Reading task state",
                            status: "active",
                        },
                    },
                },
            }),
        ).toMatchObject({
            provider: "claude",
            source: "claude_task",
            explanation: "TaskGet",
            items: [
                {
                    externalId: "task-get",
                    content: "Read task state",
                    activeForm: "Reading task state",
                    status: "in_progress",
                },
            ],
        });

        expect(
            normalizeProviderPlanSnapshot({
                provider: "claude",
                toolName: "TaskList",
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    toolUseResult: {
                        tasks: [
                            {
                                id: "task-list-a",
                                subject: "Inspect list",
                                status: "completed",
                            },
                            {
                                id: "task-list-b",
                                description: "Patch listed task",
                                activeForm: "Patching listed task",
                                status: "active",
                            },
                        ],
                    },
                },
            }),
        ).toMatchObject({
            provider: "claude",
            source: "claude_task",
            explanation: "TaskList",
            items: [
                {
                    externalId: "task-list-a",
                    seq: 1,
                    content: "Inspect list",
                    status: "completed",
                },
                {
                    externalId: "task-list-b",
                    seq: 2,
                    content: "Patch listed task",
                    activeForm: "Patching listed task",
                    status: "in_progress",
                },
            ],
        });

        expect(
            normalizeProviderPlanSnapshot({
                provider: "codex",
                toolName: "update_plan",
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: { plan: [{ step: "Use shared contract", status: "completed" }] },
            }),
        ).toMatchObject({
            provider: "codex",
            source: "codex_update_plan",
            items: [{ content: "Use shared contract", status: "completed" }],
        });
    });

    test("Claude availability advertises TodoWrite and Task tool plan signals", () => {
        expect(providerPlanSignalAvailability.claude.planSources).toEqual([
            "claude_todowrite",
            "claude_task",
        ]);
        expect(providerPlanSignalAvailability.claude.toolNames).toEqual([
            "TodoWrite",
            "TaskCreate",
            "TaskUpdate",
            "TaskGet",
            "TaskList",
        ]);
        expect(providerPlanSignalAvailability.claude.evidence).toContain("TodoWrite");
        expect(providerPlanSignalAvailability.claude.evidence).toContain("Task");
    });

    test("does not invent plan snapshots for unavailable providers", () => {
        for (const provider of ["pi", "opencode", "cursor"] as const) {
            expect(providerPlanSignalAvailability[provider].status).toBe("unavailable");
            expect(providerPlanSignalAvailability[provider].planSources).toEqual([]);
            expect(
                normalizeProviderPlanSnapshot({
                    provider,
                    toolName: "TodoWrite",
                    sessionId: "s1",
                    ts: "2026-05-09T10:00:00.000Z",
                    input: { todos: [{ content: "looks plan-like", status: "completed" }] },
                }),
            ).toBeNull();
        }
    });

    test("builds provider-scoped plan snapshot writes from normalized plans", () => {
        const normalized = normalizeCodexUpdatePlan({
            sessionId: "codex-plan-session",
            ts: "2026-05-09T10:00:00.000Z",
            input: {
                plan: [{ step: "Write once", status: "in_progress" }],
            },
        });

        const write = toPlanSnapshotWrite({
            snapshot: normalized,
            snapshotSeq: 1,
            createdAt: normalized.ts,
            toolCallKey: "codex-plan-session__tool__call_plan",
        });

        expect(write.planKey).toMatch(/^codex__codex_plan_session__codex_update_plan__/);
        expect(write.snapshotKey).toContain("__snapshot_000001__");
        expect(write.items[0]?.key).toMatch(/__item_001$/);
        expect(write.status).toBe("in_progress");
    });

    test("keys Claude task current items by task id instead of sequence", () => {
        const first = toPlanSnapshotWrite({
            snapshot: normalizeClaudeTaskUpdate({
                sessionId: "claude-task-session",
                ts: "2026-05-09T10:00:00.000Z",
                input: { taskId: "task-a", status: "in_progress" },
            }),
            snapshotSeq: 1,
            createdAt: "2026-05-09T10:00:00.000Z",
            toolCallKey: "claude-task-session__tool__task-a",
        });
        const second = toPlanSnapshotWrite({
            snapshot: normalizeClaudeTaskUpdate({
                sessionId: "claude-task-session",
                ts: "2026-05-09T10:00:01.000Z",
                input: { taskId: "task-b", status: "in_progress" },
            }),
            snapshotSeq: 2,
            createdAt: "2026-05-09T10:00:00.000Z",
            toolCallKey: "claude-task-session__tool__task-b",
        });

        expect(first.items[0]?.seq).toBe(1);
        expect(second.items[0]?.seq).toBe(1);
        expect(first.items[0]?.key).not.toBe(second.items[0]?.key);
        expect(first.items[0]?.key).toContain("__item_external__task_a__");
        expect(second.items[0]?.key).toContain("__item_external__task_b__");
    });

    test("handles malformed unknown payloads without throwing", () => {
        expect(
            normalizeCodexUpdatePlan({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: "{not-json",
            }),
        ).toMatchObject({
            source: "codex_update_plan",
            explanation: null,
            items: [],
        });

        expect(
            normalizeClaudeTodoWrite({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: null,
            }).items,
        ).toEqual([]);
        expect(
            normalizeClaudeTaskCreate({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: "{not-json",
            }),
        ).toMatchObject({
            source: "claude_task",
            explanation: "TaskCreate",
            items: [],
        });
        expect(
            normalizeClaudeTaskUpdate({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: null,
            }),
        ).toMatchObject({
            source: "claude_task",
            explanation: "TaskUpdate",
            items: [],
        });
    });

    test("filters empty items and defaults unknown statuses to pending", () => {
        expect(
            normalizeClaudeTodoWrite({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    todos: [
                        { content: "  ", status: "completed" },
                        { content: "Review patch", status: "blocked" },
                        { content: "Stop work", status: "abandoned" },
                    ],
                },
            }).items,
        ).toEqual([
            {
                externalId: null,
                seq: 1,
                content: "Review patch",
                activeForm: null,
                status: "pending",
            },
            {
                externalId: null,
                seq: 2,
                content: "Stop work",
                activeForm: null,
                status: "abandoned",
            },
        ]);

        expect(
            normalizeCodexUpdatePlan({
                sessionId: "s1",
                ts: "2026-05-09T10:00:00.000Z",
                input: {
                    plan: [
                        { step: "", status: "in_progress" },
                        { step: "Ship it", status: "done" },
                    ],
                },
            }).items,
        ).toEqual([
            {
                externalId: null,
                seq: 1,
                content: "Ship it",
                activeForm: null,
                status: "pending",
            },
        ]);
    });
});
