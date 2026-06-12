/**
 * Tests for thinking-analytics.ts: pure rollup + fetch join via mock DB.
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";

import { fetchThinking, rollupThinkingByModel } from "./thinking-analytics.ts";

type QueryResult = Array<Record<string, unknown>>;

const makeMockDb = (results: QueryResult[]): Layer.Layer<SurrealClient> => {
    const stub: SurrealClientShape = {
        query: (_sql: string) => Effect.succeed(results as [QueryResult, ...QueryResult[]]),
    } as unknown as SurrealClientShape;
    return Layer.succeed(SurrealClient, stub);
};

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

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
        );
        expect(rows).toHaveLength(0);
    });
});

describe("fetchThinking", () => {
    it("joins thinking rows to session models and maps codex signals", async () => {
        const thinking = [
            { session_id: "session:`s1`", blocks: 2, tokens: 800, assistant_turns: 4, thinking_turns: 2 },
        ];
        const sessions = [
            { session_id: "session:`s1`", model: "claude-fable-5", source: "claude" },
        ];
        const efforts = [
            { model: "gpt-5.5", reasoning_effort: "medium", sessions: 7 },
        ];
        const reasoning = [
            { model: "gpt-5.5", sessions: 7, reasoning_tokens: 5000, completion_tokens: 20000 },
        ];
        const result = await run(
            fetchThinking({ sinceDays: 14 }),
            makeMockDb([thinking, sessions, efforts, reasoning]),
        );
        expect(result.models).toHaveLength(1);
        expect(result.models[0].model).toBe("claude-fable-5");
        expect(result.models[0].thinking_tokens).toBe(800);
        expect(result.codex_efforts).toEqual([
            { model: "gpt-5.5", reasoning_effort: "medium", sessions: 7 },
        ]);
        expect(result.codex_reasoning[0].reasoning_share_pct).toBeCloseTo(25);
        expect(result.window_days).toBe(14);
    });
});
