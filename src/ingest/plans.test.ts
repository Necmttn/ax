import { describe, expect, test } from "bun:test";
import {
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
