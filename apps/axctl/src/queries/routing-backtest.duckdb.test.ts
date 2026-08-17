/**
 * `runRoutingBacktest` against a REAL published DuckDB snapshot.
 *
 * This file exists because of a defect a mock cannot see. `runRoutingBacktest`
 * was once HALF-ported: the dispatch half read the DuckDB cache through
 * `fetchDispatches` (`CacheRead`), while the pricing-catalog half read a
 * table nothing wrote to anymore. A dead reader does not error, it returns
 * `[]`, so the pricing catalog was always empty and `estSavingsUsd` was
 * PROVABLY ZERO for every candidate, no matter how expensive the matched
 * dispatch actually was.
 *
 * This test seeds a real DuckDB snapshot with one inherit dispatch that ran on
 * an expensive model (`claude-fable-5`) and a cheap-tier `agent_model` pricing
 * row for the suggested model (`claude-sonnet-4-6`), then asserts
 * `estSavingsUsd` is POSITIVE, guarding against that regressing silently again.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { runRoutingBacktest } from "./routing-backtest.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("routing backtest", { requireFts: true });

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);

const PARENT = "019e2531-b552-7b53-a029-c780adbb6560";
const CHILD = "019e2531-ffff-7b53-a029-c780adbb6561";

describe("runRoutingBacktest over a published snapshot", () => {
    dtest("prices matched candidates from the real agent_model table (estSavingsUsd > 0)", async () => {
        const dir = tempDir("routing-backtest");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    // An inherit dispatch, matched by the "^implement" pattern,
                    // that ran on the expensive tier.
                    yield* write.put("spawned", {
                        id: "spawned:1",
                        in_id: PARENT,
                        out_id: CHILD,
                        ts: hoursAgo(2),
                        agent_type: "general-purpose",
                        description: "implement the pricing fix",
                        tool_use_id: null,
                    });
                    yield* write.put("session_token_usage", {
                        id: "stu:1",
                        session: CHILD,
                        source: "claude-subagent",
                        model: "claude-fable-5",
                        prompt_tokens: 1_000_000n,
                        completion_tokens: 0n,
                        cache_read_input_tokens: 0n,
                        cache_creation_input_tokens: 0n,
                        estimated_tokens: 1_000_000n,
                        transcript_bytes: 4096n,
                        estimated_cost_usd: 50,
                        ts: hoursAgo(2),
                    });
                    // The real pricing catalog row the dead reader never saw.
                    yield* write.put("agent_model", {
                        id: "agent_model:claude-sonnet-4-6",
                        name: "claude-sonnet-4-6",
                        provider: "anthropic",
                        display_name: "Claude Sonnet 4.6",
                        input_per_million_usd: 3,
                        output_per_million_usd: 15,
                        cache_creation_per_million_usd: 3.75,
                        cache_read_per_million_usd: 0.3,
                        fast_multiplier: 1,
                        pricing_source: "test",
                    });
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const result = await Effect.runPromise(
            runRoutingBacktest({
                pattern: "^implement",
                flags: "i",
                suggest: "sonnet",
                days: 14,
            }).pipe(Effect.provide(layer)),
        );

        expect(result.matched).toHaveLength(1);
        expect(result.matched[0]!.childModel).toBe("claude-fable-5");
        // THE number: this was 0 for every candidate when agent_model pricing
        // came back empty from a dead reader (see module doc above).
        expect(result.estSavingsUsd).toBeGreaterThan(0);
        // Sanity bound: sonnet's input rate at 1M prompt tokens is $3, so the
        // repriced cost is far below the $50 fable actually cost.
        expect(result.estSavingsUsd).toBeGreaterThan(40);
    });
});
