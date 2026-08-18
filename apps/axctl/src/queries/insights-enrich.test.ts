/**
 * Tests for src/queries/insights-enrich.ts - post-query context enrichment for
 * the classifier insight views.
 *
 * Regression guard: context lookups must use BOUND session ids (`session = ?`,
 * indexed) - never a correlated `$parent.session` subquery - and inject the
 * same field names the old correlated SQL emitted, so formatInsightRows is
 * unchanged.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestCacheRead } from "@ax/lib/testing/cache";
import { enrichInsightRows, foldContentTypeOntoFriction } from "./insights-enrich.ts";

function makeMockDb() {
    return makeTestCacheRead({
        fallback: (sql) => {
            if (sql.includes("FROM turn") && sql.includes("role = 'assistant'")) {
                return [{ id: "turn:prev", seq: 4, text: "previous reply" }];
            }
            if (sql.includes("FROM tool_call") && sql.includes("has_error = TRUE")) {
                return [{ id: "tool_call:f1", name: "Bash", command_norm: "bun", error_text: "boom", output_excerpt: null, ts: "2026-05-01T00:00:00.000Z" }];
            }
            if (sql.includes("FROM tool_call")) {
                return [{
                    id: "tool_call:l1", name: "Edit", command_norm: null, has_error: false,
                    status: null, exit_code: null, output_excerpt: null, error_text: null,
                    ts: "2026-05-01T00:10:00.000Z",
                }];
            }
            if (sql.includes("FROM command_outcome")) {
                return [{
                    id: "command_outcome:o1", kind: "expected_feedback", status: "ok",
                    command_norm: null, command_tool: null, text: null, tool_call: null,
                    ts: "2026-05-01T00:11:00.000Z",
                }];
            }
            if (sql.includes("FROM turn") && sql.includes("role = 'user'")) {
                return [{ id: "turn:u6", seq: 6, role: "user", text: "next ask", ts: "2026-05-01T00:12:00.000Z" }];
            }
            return [];
        },
    });
}

const baseRow = {
    id: "classifier_result:r1",
    session: "s1",
    user_seq: 5,
    ts: new Date("2026-05-01T00:05:00.000Z"),
};

describe("enrichInsightRows", () => {
    test("classifier-facts: injects previous_assistant + recent_tool_failures via bound session ids", async () => {
        const { layer, captured } = makeMockDb();
        const rows = await Effect.runPromise(
            enrichInsightRows("classifier-facts", [baseRow]).pipe(Effect.provide(layer)),
        );
        for (const sql of captured) {
            expect(sql).not.toContain("$parent");
            expect(sql).toContain("session = ?");
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
        expect(captured.some((s) => s.includes("has_error = TRUE") && s.includes("LIMIT 5"))).toBe(true);
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

    test("friction: enriches rows with otlp_cost_usd and otlp_tokens via a single batch", async () => {
        const cache = makeTestCacheRead({
            routes: [
                {
                    match: "FROM otel_metric_point",
                    rows: [
                        { session_id: "s1", metric: "claude_code.cost.usage", total: 0.25 },
                        { session_id: "s1", metric: "claude_code.token.usage", total: 800 },
                    ],
                },
                { match: "FROM otel_log_event", rows: [] },
                { match: "FROM has_content", rows: [] },
            ],
        });
        const frictionRows = [
            { id: "friction_event:f1", session_ref: "s1", session: "s1", kind: "tool_failure", ts: new Date() },
            { id: "friction_event:f2", session_ref: "s2", session: "s2", kind: "tool_failure", ts: new Date() },
        ];
        const rows = await Effect.runPromise(
            enrichInsightRows("friction", frictionRows).pipe(Effect.provide(cache.layer)),
        );
        expect(rows[0]!.otlp_cost_usd).toBe(0.25);
        expect(rows[0]!.otlp_tokens).toBe(800);
        expect(rows[1]!.otlp_cost_usd).toBeNull();
        expect(rows[1]!.otlp_tokens).toBeNull();
    });

    test("friction: enriches rows with contentType from session-dominant has_content category", async () => {
        const cache = makeTestCacheRead({
            routes: [
                {
                    match: "FROM has_content",
                    rows: [
                        { sid: "s1", ct: "content_type:unknown", bytes: 500 },
                        { sid: "s1", ct: "content_type:code", bytes: 200 },
                    ],
                },
                { match: "FROM otel_metric_point", rows: [] },
                { match: "FROM otel_log_event", rows: [] },
            ],
        });
        const frictionRows = [
            { id: "friction_event:f1", session_ref: "s1", session: "s1", kind: "tool_failure", ts: new Date() },
            { id: "friction_event:f2", session_ref: "s2", session: "s2", kind: "tool_failure", ts: new Date() },
        ];
        const rows = await Effect.runPromise(
            enrichInsightRows("friction", frictionRows).pipe(Effect.provide(cache.layer)),
        );
        // session s1 has dominant category "unknown" (500 bytes > 200)
        expect(rows[0]!.contentType).toBe("unknown");
        // session s2 has no has_content data
        expect(rows[1]!.contentType).toBeNull();
    });
});

describe("foldContentTypeOntoFriction", () => {
    test("tags each friction row with the dominant content type of its session", () => {
        const rows = [
            { id: "friction_event:f1", session_ref: "s1", session: "s1" },
            { id: "friction_event:f2", session_ref: "s2", session: "s2" },
        ];
        const bySession = new Map([["s1", "unknown"]]);
        const out = foldContentTypeOntoFriction(rows as never, bySession);
        expect(out[0]!.contentType).toBe("unknown");
        expect(out[1]!.contentType).toBeNull();
    });

    test("uses session_ref when present, falls back to session field", () => {
        const rows = [
            { id: "friction_event:f3", session: "abc" },
        ];
        const bySession = new Map([["abc", "text"]]);
        const out = foldContentTypeOntoFriction(rows as never, bySession);
        expect(out[0]!.contentType).toBe("text");
    });
});
