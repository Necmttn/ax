/**
 * Tests for src/queries/insights-enrich.ts - post-query context enrichment for
 * the classifier insight views.
 *
 * Regression guard: context lookups must use LITERAL session ids
 * (`session = session:\`...\``, indexed) - never `$parent.session` - and inject
 * the same field names the old correlated SQL emitted, so formatInsightRows is
 * unchanged.
 */
import { describe, expect, test } from "bun:test";
import { Effect, type Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { enrichInsightRows } from "./insights-enrich.ts";

function makeMockDb(): { layer: Layer.Layer<SurrealClient>; captured: string[] } {
    const tc = makeTestSurrealClient({
        fallback: (sql) => {
            if (sql.includes("FROM turn") && sql.includes('role = "assistant"')) {
                return [[{ id: "turn:prev", seq: 4, text: "previous reply" }]];
            }
            if (sql.includes("FROM tool_call") && sql.includes("has_error = true")) {
                return [[{ id: "tool_call:f1", name: "Bash", command_norm: "bun", error_text: "boom", output_excerpt: null, ts: "2026-05-01T00:00:00.000Z" }]];
            }
            if (sql.includes("FROM tool_call")) {
                return [[{ id: "tool_call:l1", name: "Edit", ts: "2026-05-01T00:10:00.000Z" }]];
            }
            if (sql.includes("FROM command_outcome")) {
                return [[{ id: "command_outcome:o1", kind: "expected_feedback", ts: "2026-05-01T00:11:00.000Z" }]];
            }
            if (sql.includes("FROM turn") && sql.includes('role = "user"')) {
                return [[{ id: "turn:u6", seq: 6, role: "user", text: "next ask", ts: "2026-05-01T00:12:00.000Z" }]];
            }
            return [[]];
        },
    });
    return { layer: tc.layer, captured: tc.captured };
}

const baseRow = {
    id: "classifier_result:r1",
    session: "session:`s1`",
    user_seq: 5,
    ts: new Date("2026-05-01T00:05:00.000Z"),
};

describe("enrichInsightRows", () => {
    test("classifier-facts: injects previous_assistant + recent_tool_failures via literal session ids", async () => {
        const { layer, captured } = makeMockDb();
        const rows = await Effect.runPromise(
            enrichInsightRows("classifier-facts", [baseRow]).pipe(Effect.provide(layer)),
        );
        for (const sql of captured) {
            expect(sql).not.toContain("$parent");
            expect(sql).toContain("session = session:`s1`");
        }
        expect(rows[0]!.previous_assistant).toMatchObject({ id: "turn:prev", text: "previous reply" });
        expect(rows[0]!.recent_tool_failures).toHaveLength(1);
        // facts cap failures at 3
        expect(captured.some((s) => s.includes("LIMIT 3"))).toBe(true);
    });

    test("correction-contexts: failure lookback is LIMIT 5", async () => {
        const { layer, captured } = makeMockDb();
        await Effect.runPromise(
            enrichInsightRows("correction-contexts", [baseRow]).pipe(Effect.provide(layer)),
        );
        expect(captured.some((s) => s.includes("has_error = true") && s.includes("LIMIT 5"))).toBe(true);
    });

    test("classifier-outcomes: injects later_tool_calls / later_command_outcomes / later_user_turns", async () => {
        const { layer, captured } = makeMockDb();
        const rows = await Effect.runPromise(
            enrichInsightRows("classifier-outcomes", [baseRow]).pipe(Effect.provide(layer)),
        );
        for (const sql of captured) expect(sql).not.toContain("$parent");
        expect(rows[0]!.later_tool_calls).toHaveLength(1);
        expect(rows[0]!.later_command_outcomes).toHaveLength(1);
        expect(rows[0]!.later_user_turns).toHaveLength(1);
    });

    test("non-classifier views pass through with zero queries", async () => {
        const { layer, captured } = makeMockDb();
        const rows = await Effect.runPromise(
            enrichInsightRows("repositories", [baseRow]).pipe(Effect.provide(layer)),
        );
        expect(captured).toHaveLength(0);
        expect(rows[0]).toBe(baseRow);
    });

    test("a row with no session passes through unenriched (no throw)", async () => {
        const { layer } = makeMockDb();
        const rows = await Effect.runPromise(
            enrichInsightRows("classifier-facts", [{ id: "classifier_result:r2" }]).pipe(Effect.provide(layer)),
        );
        expect(rows[0]!.previous_assistant).toBeUndefined();
    });
});
