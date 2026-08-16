/**
 * Tests for thinking-analytics.ts: pure rollup + fetchThinking over a real
 * published DuckDB snapshot (spar exclusion still routes through the
 * SQLite-backed `Judgment` test layer - fetchSparSessionIds was ported off
 * SurrealDB in an earlier chunk and is untouched here).
 */
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import type { Judgment } from "@ax/lib/sqlite";
import type { CacheRead } from "@ax/lib/duckdb/seam";

import { fetchThinking, reasoningCostUsd, rollupThinkingByModel } from "./thinking-analytics.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("thinking analytics", { requireFts: true });

const run = <A>(eff: Effect.Effect<A, unknown, Judgment | CacheRead>, layer: Layer.Layer<Judgment | CacheRead>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);

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
    const S1 = "019e2531-b552-7b53-a029-c780adbb6560";
    const T1 = "019e2531-b552-7b53-a029-c780adbb6561";
    const CODEX_SESSION = "019e2531-b552-7b53-a029-c780adbb6562";

    dtest("joins thinking rows to session models and maps codex signals", async () => {
        const dir = tempDir("thinking-join");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("session", {
                        id: S1, model: "claude-fable-5", source: "claude", reasoning_effort: "high",
                        started_at: hoursAgo(1),
                    });
                    yield* write.put("session", {
                        id: CODEX_SESSION, model: "gpt-5.5", source: "codex", reasoning_effort: "medium",
                        started_at: hoursAgo(1),
                    });
                    yield* write.put("turn", {
                        id: T1, session: S1, seq: 1n, ts: hoursAgo(1), role: "assistant",
                        thinking_blocks: 2n, thinking_tokens: 800n,
                    });
                    yield* write.put("session_token_usage", {
                        id: "stu:1", session: CODEX_SESSION, source: "codex", model: "gpt-5.5",
                        reasoning_output_tokens: 5000n, completion_tokens: 20000n,
                        estimated_tokens: 25000n, transcript_bytes: 4096n, ts: hoursAgo(1),
                    });
                    yield* write.put("agent_model", {
                        id: "agent_model:claude-fable-5", name: "claude-fable-5", provider: "anthropic",
                        display_name: "Claude Fable 5", output_per_million_usd: 15,
                    });
                    yield* write.put("agent_model", {
                        id: "agent_model:gpt-5.5", name: "gpt-5.5", provider: "openai",
                        display_name: "GPT 5.5", output_per_million_usd: 20,
                    });
                }),
            ),
        );
        const layer = Layer.merge(readFixture(fixture.snapshotPath, dylibPath), judgmentTestLayer());

        const result = await run(fetchThinking({ sinceDays: 14 }), layer);

        expect(result.models).toHaveLength(1);
        expect(result.models[0].model).toBe("claude-fable-5");
        expect(result.models[0].thinking_tokens).toBe(800);
        // 800 thinking tokens x $15/M -> $0.012
        expect(result.models[0].thinking_cost_usd).toBeCloseTo(0.012);
        expect(result.efforts).toEqual(
            expect.arrayContaining([
                { source: "codex", model: "gpt-5.5", reasoning_effort: "medium", sessions: 1 },
                { source: "claude", model: "claude-fable-5", reasoning_effort: "high", sessions: 1 },
            ]),
        );
        expect(result.codex_reasoning).toHaveLength(1);
        expect(result.codex_reasoning[0]!.reasoning_share_pct).toBeCloseTo(25);
        // 5000 reasoning tokens x $20/M -> $0.1
        expect(result.codex_reasoning[0]!.reasoning_cost_usd).toBeCloseTo(0.1);
        expect(result.window_days).toBe(14);
    });

    dtest("excludes a spar-tagged session from thinking totals", async () => {
        // s1 is a normal session; spar-s2 is a spar variant that should be dropped.
        const SPAR_SESSION = "019e2531-b552-7b53-a029-c780adbb6563";
        const SPAR_TURN = "019e2531-b552-7b53-a029-c780adbb6564";
        const dir = tempDir("thinking-spar");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("session", { id: S1, model: "claude-fable-5", source: "claude", started_at: hoursAgo(1) });
                    yield* write.put("session", { id: SPAR_SESSION, model: "claude-fable-5", source: "claude", started_at: hoursAgo(1) });
                    yield* write.put("turn", {
                        id: T1, session: S1, seq: 1n, ts: hoursAgo(1), role: "assistant",
                        thinking_blocks: 2n, thinking_tokens: 800n,
                    });
                    yield* write.put("turn", {
                        id: SPAR_TURN, session: SPAR_SESSION, seq: 1n, ts: hoursAgo(1), role: "assistant",
                        thinking_blocks: 5n, thinking_tokens: 5000n,
                    });
                    yield* write.put("agent_model", {
                        id: "agent_model:claude-fable-5", name: "claude-fable-5", provider: "anthropic",
                        display_name: "Claude Fable 5", output_per_million_usd: 15,
                    });
                }),
            ),
        );
        // fetchSparSessionIds reads `session_label` through the Judgment sidecar
        // (already ported off SurrealDB); route it to flag SPAR_SESSION.
        const sparLayer = judgmentTestLayer(() => [{ session_id: SPAR_SESSION }]);
        const layer = Layer.merge(readFixture(fixture.snapshotPath, dylibPath), sparLayer);

        const result = await run(fetchThinking({ sinceDays: 14 }), layer);

        // Only s1's thinking tokens (800) should appear; spar-s2's 5000 excluded.
        expect(result.models).toHaveLength(1);
        expect(result.models[0].thinking_tokens).toBe(800);
        expect(result.models[0].sessions).toBe(1);
    });
});
