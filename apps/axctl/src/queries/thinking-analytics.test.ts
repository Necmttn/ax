/**
 * Tests for thinking-analytics.ts: pure rollup + fetch join via mock DB.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";

import { fetchThinking, reasoningCostUsd, rollupThinkingByModel } from "./thinking-analytics.ts";

type QueryResult = Array<Record<string, unknown>>;

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

/**
 * Build a test layer for fetchThinking that routes:
 *   - The spar-sessions query (contains "string::contains") → sparRows
 *   - Everything else (the batched 5-statement thinking SQL) → batchResults
 *
 * Route response shape:
 *   spar query returns `[Array<{id}>]` (1-tuple) → route rows = [sparRows]
 *   batch query returns `[thinking, sessions, efforts, reasoning, models]` → fallback = batchResults
 */
const makeThinkingMock = (
    batchResults: QueryResult[],
    sparRows: Array<{ id: string }> = [],
): Layer.Layer<SurrealClient> => {
    const tc = makeTestSurrealClient({
        denyWrites: true,
        routes: {
            // spar query: SELECT type::string(id) ... WHERE string::contains(labels, 'spar')
            // returns [Array<{id}>] - one statement result
            "string::contains(labels": [sparRows] as unknown as Array<unknown[]>,
        },
        // fallback: the batched 5-statement query returns batchResults tuple
        fallback: batchResults as unknown as Array<unknown[]>,
    });
    return tc.layer;
};

describe("rollupThinkingByModel", () => {
    it("aggregates per model with pct and avg tokens", () => {
        const rows = rollupThinkingByModel(
            [
                { session_id: "session:`a`", blocks: 4, tokens: 2000, assistant_turns: 10, thinking_turns: 4 },
                { session_id: "session:`b`", blocks: 6, tokens: 1000, assistant_turns: 10, thinking_turns: 6 },
                { session_id: "session:`c`", blocks: 0, tokens: 0, assistant_turns: 5, thinking_turns: 0 },
            ],
            new Map([
                ["a", "claude-fable-5"],
                ["b", "claude-fable-5"],
                ["c", "claude-sonnet-4-6"],
            ]),
            new Map(),
        );
        expect(rows).toHaveLength(2);
        const fable = rows.find((r) => r.model === "claude-fable-5");
        expect(fable?.sessions).toBe(2);
        expect(fable?.assistant_turns).toBe(20);
        expect(fable?.thinking_turns).toBe(10);
        expect(fable?.thinking_blocks).toBe(10);
        expect(fable?.thinking_tokens).toBe(3000);
        expect(fable?.thinking_turn_pct).toBeCloseTo(50);
        expect(fable?.avg_tokens_per_thinking_turn).toBeCloseTo(300);
        const sonnet = rows.find((r) => r.model === "claude-sonnet-4-6");
        expect(sonnet?.thinking_turn_pct).toBe(0);
        expect(sonnet?.avg_tokens_per_thinking_turn).toBe(0);
    });

    it("skips sessions with no model mapping", () => {
        const rows = rollupThinkingByModel(
            [{ session_id: "session:`x`", blocks: 1, tokens: 10, assistant_turns: 1, thinking_turns: 1 }],
            new Map(),
            new Map(),
        );
        expect(rows).toHaveLength(0);
    });

    it("computes thinking_cost_usd from the pricing map (tokens x output rate / 1e6)", () => {
        const rows = rollupThinkingByModel(
            [
                // 700,000 thinking tokens for fable at $15/M output -> $10.50
                { session_id: "session:`a`", blocks: 4, tokens: 400000, assistant_turns: 10, thinking_turns: 4 },
                { session_id: "session:`b`", blocks: 6, tokens: 300000, assistant_turns: 10, thinking_turns: 6 },
                // 200,000 thinking tokens for sonnet at $5/M output -> $1.00
                { session_id: "session:`c`", blocks: 2, tokens: 200000, assistant_turns: 5, thinking_turns: 2 },
                // unpriced model -> cost 0
                { session_id: "session:`d`", blocks: 1, tokens: 100000, assistant_turns: 2, thinking_turns: 1 },
                // model present but null rate -> cost 0
                { session_id: "session:`e`", blocks: 1, tokens: 100000, assistant_turns: 2, thinking_turns: 1 },
            ],
            new Map([
                ["a", "claude-fable-5"],
                ["b", "claude-fable-5"],
                ["c", "claude-sonnet-4-6"],
                ["d", "claude-haiku-x"],
                ["e", "claude-null-rate"],
            ]),
            new Map<string, number | null>([
                ["claude-fable-5", 15],
                ["claude-sonnet-4-6", 5],
                ["claude-null-rate", null],
                // claude-haiku-x intentionally absent from the pricing map
            ]),
        );
        expect(rows.find((r) => r.model === "claude-fable-5")?.thinking_cost_usd).toBeCloseTo(10.5);
        expect(rows.find((r) => r.model === "claude-sonnet-4-6")?.thinking_cost_usd).toBeCloseTo(1.0);
        expect(rows.find((r) => r.model === "claude-haiku-x")?.thinking_cost_usd).toBe(0);
        expect(rows.find((r) => r.model === "claude-null-rate")?.thinking_cost_usd).toBe(0);
    });

    it("normalizes the raw session model before the rate lookup (mixed case still bills)", () => {
        // session.model is raw ("Claude-Fable-5"); the rate map is keyed by
        // agent_model.name == normalizeModelName(raw) == "claude-fable-5".
        // Without normalization the lookup misses and cost silently drops to $0.
        const rows = rollupThinkingByModel(
            [
                // 200,000 thinking tokens at $50/M output -> $10.00
                { session_id: "session:`a`", blocks: 2, tokens: 200000, assistant_turns: 5, thinking_turns: 2 },
            ],
            new Map([["a", "Claude-Fable-5"]]),
            new Map<string, number | null>([["claude-fable-5", 50]]),
        );
        const row = rows.find((r) => r.model === "Claude-Fable-5");
        expect(row?.thinking_cost_usd).toBeCloseTo(10.0);
    });
});

describe("reasoningCostUsd", () => {
    it("computes tokens x rate / 1e6", () => {
        expect(reasoningCostUsd(5000, 20)).toBeCloseTo(0.1);
        expect(reasoningCostUsd(700000, 15)).toBeCloseTo(10.5);
    });

    it("returns 0 for null/missing/non-finite rate", () => {
        expect(reasoningCostUsd(5000, null)).toBe(0);
        expect(reasoningCostUsd(5000, undefined)).toBe(0);
        expect(reasoningCostUsd(5000, Number.NaN)).toBe(0);
    });

    it("returns 0 for zero tokens", () => {
        expect(reasoningCostUsd(0, 20)).toBe(0);
    });
});

describe("fetchThinking", () => {
    // fetchThinking now issues two db.query() calls:
    //   1. fetchSparSessionIds (SQL contains "string::contains(labels")
    //   2. the batched 5-statement thinking/session/effort/reasoning/model SQL
    //
    // makeThinkingMock routes by SQL pattern so each call gets the right data.

    it("joins thinking rows to session models and maps codex signals", async () => {
        const thinking = [
            { session_id: "session:`s1`", blocks: 2, tokens: 800, assistant_turns: 4, thinking_turns: 2 },
        ];
        const sessions = [
            { session_id: "session:`s1`", model: "claude-fable-5", source: "claude" },
        ];
        const efforts = [
            { source: "codex", model: "gpt-5.5", reasoning_effort: "medium", sessions: 7 },
            { source: "claude", model: "claude-fable-5", reasoning_effort: "high", sessions: 3 },
        ];
        const reasoning = [
            { model: "gpt-5.5", sessions: 7, reasoning_tokens: 5000, completion_tokens: 20000 },
        ];
        const agentModels = [
            { name: "claude-fable-5", output_per_million_usd: 15 },
            { name: "gpt-5.5", output_per_million_usd: 20 },
        ];
        const result = await run(
            fetchThinking({ sinceDays: 14 }),
            makeThinkingMock([thinking, sessions, efforts, reasoning, agentModels]),
        );
        expect(result.models).toHaveLength(1);
        expect(result.models[0].model).toBe("claude-fable-5");
        expect(result.models[0].thinking_tokens).toBe(800);
        // 800 thinking tokens x $15/M -> $0.012
        expect(result.models[0].thinking_cost_usd).toBeCloseTo(0.012);
        expect(result.efforts).toEqual([
            { source: "codex", model: "gpt-5.5", reasoning_effort: "medium", sessions: 7 },
            { source: "claude", model: "claude-fable-5", reasoning_effort: "high", sessions: 3 },
        ]);
        expect(result.codex_reasoning[0].reasoning_share_pct).toBeCloseTo(25);
        // 5000 reasoning tokens x $20/M -> $0.1
        expect(result.codex_reasoning[0].reasoning_cost_usd).toBeCloseTo(0.1);
        expect(result.window_days).toBe(14);
    });

    it("excludes a spar-tagged session from thinking totals", async () => {
        // s1 is a normal session; spar-s2 is a spar variant that should be dropped.
        const thinking = [
            { session_id: "session:s1", blocks: 2, tokens: 800, assistant_turns: 4, thinking_turns: 2 },
            { session_id: "session:spar-s2", blocks: 5, tokens: 5000, assistant_turns: 10, thinking_turns: 5 },
        ];
        const sessions = [
            { session_id: "session:s1", model: "claude-fable-5", source: "claude" },
            { session_id: "session:spar-s2", model: "claude-fable-5", source: "claude" },
        ];
        const agentModels = [
            { name: "claude-fable-5", output_per_million_usd: 15 },
        ];
        const result = await run(
            fetchThinking({ sinceDays: 14 }),
            // sparRows: spar-s2 is flagged; makeThinkingMock routes spar query to [sparRows]
            makeThinkingMock(
                [thinking, sessions, [], [], agentModels],
                [{ id: "session:spar-s2" }],
            ),
        );
        // Only s1's thinking tokens (800) should appear; spar-s2's 5000 excluded.
        expect(result.models).toHaveLength(1);
        expect(result.models[0].thinking_tokens).toBe(800);
        expect(result.models[0].sessions).toBe(1);
    });
});
