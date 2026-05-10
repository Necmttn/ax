import { describe, expect, test } from "bun:test";
import {
    normalizeClaudeTodoWrite,
    normalizeCodexUpdatePlan,
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
