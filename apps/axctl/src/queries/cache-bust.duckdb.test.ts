/**
 * The cache-bust model + `fetchCacheBustCost` (#868) end-to-end against a
 * REAL published DuckDB snapshot.
 *
 * Pins what a mocked seam cannot see:
 *  1. The model materializes ONLY reason-carrying rows, priced twice (ingest
 *     price passed through; corroboration = flat rate off `agent_model`, null
 *     when the model_ref does not resolve to a rate).
 *  2. The read window actually FILTERS (one bust is seeded 60 days back).
 *  3. Coverage is claude-only (a codex usage row must not inflate the
 *     denominator) while the reason rollup itself is provider-agnostic.
 *  4. The version-marked cutover: first run rebuilds, second run with the
 *     same SQL is windowed + idempotent (same row count, no duplicates).
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { CacheRead, type CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { runCacheBustModels, type CacheBustModelStats } from "../ingest/models/cache-bust-models.ts";
import { fetchCacheBustCost } from "./cache-bust.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("cache bust cost", { requireFts: true });

const hoursAgo = (h: number): Date => new Date(Date.now() - h * 60 * 60 * 1000);
const daysAgo = (d: number): Date => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

const SESSION_A = "019e2531-b552-7b53-a029-c780adbb6560";
const SESSION_B = "019e2531-ffff-7b53-a029-c780adbb6561";

interface UsageSeed {
    readonly id: string;
    readonly session: string;
    readonly seq: number;
    readonly ts: Date;
    readonly source: string;
    readonly cacheCreationTokens: bigint;
    readonly cacheCreationUsd: number | null;
    readonly modelRef?: string | null;
    readonly skill?: string | null;
    readonly agent?: string | null;
    readonly cacheMiss?: string | null;
}

const usageRow = (seed: UsageSeed) => ({
    id: seed.id,
    session: seed.session,
    turn: seed.id,
    seq: seed.seq,
    source: seed.source,
    model: "claude-opus-4-8",
    model_ref: seed.modelRef ?? null,
    prompt_tokens: 1000n,
    completion_tokens: 100n,
    cache_creation_input_tokens: seed.cacheCreationTokens,
    cache_read_input_tokens: 0n,
    fresh_input_tokens: 1000n,
    estimated_tokens: 1100n,
    estimated_cache_creation_cost_usd: seed.cacheCreationUsd,
    estimated_cost_usd: (seed.cacheCreationUsd ?? 0) + 1,
    usage_source: "claude_transcript.message_usage",
    usage_quality: "provider_turn",
    attribution_skill: seed.skill ?? null,
    attribution_agent: seed.agent ?? null,
    cache_miss_reason_type: seed.cacheMiss ?? null,
    api_error_status: null,
    ts: seed.ts,
});

const seedFixture = (write: CacheWriteService) =>
    Effect.gen(function* () {
        // A priced model row: $18.75 per million cache-creation tokens.
        yield* write.put("agent_model", {
            id: "am:opus", name: "claude-opus-4-8", provider: "anthropic",
            display_name: "Claude Opus 4.8", cache_creation_per_million_usd: 18.75,
        });
        yield* write.putMany("turn_token_usage", [
            // Bust with skill attribution + resolvable rate: corroborated =
            // 1,000,000 * 18.75 / 1e6 = $18.75 vs ingest's $20 (within 25%).
            usageRow({
                id: "ttu:1", session: SESSION_A, seq: 1, ts: hoursAgo(2), source: "claude",
                cacheCreationTokens: 1_000_000n, cacheCreationUsd: 20, modelRef: "am:opus",
                skill: "superpowers:subagent-driven-development", cacheMiss: "messages_changed",
            }),
            // Bust without a model_ref: corroborated stays null, excluded
            // from the corroboration sums but present in the reason rollup.
            usageRow({
                id: "ttu:2", session: SESSION_B, seq: 1, ts: hoursAgo(3), source: "claude-subagent",
                cacheCreationTokens: 200_000n, cacheCreationUsd: 4,
                agent: "design-curator", cacheMiss: "previous_message_not_found",
            }),
            // No reason: contributes to the coverage denominator only.
            usageRow({
                id: "ttu:3", session: SESSION_A, seq: 2, ts: hoursAgo(4), source: "claude",
                cacheCreationTokens: 500_000n, cacheCreationUsd: 10,
            }),
            // OUTSIDE the 7-day read window - proves the bound filters.
            usageRow({
                id: "ttu:old", session: SESSION_A, seq: 3, ts: daysAgo(60), source: "claude",
                cacheCreationTokens: 100_000n, cacheCreationUsd: 2, modelRef: "am:opus",
                cacheMiss: "messages_changed",
            }),
            // A codex row - no reason today, must not enter claude coverage.
            usageRow({
                id: "ttu:codex", session: SESSION_B, seq: 4, ts: hoursAgo(1), source: "codex",
                cacheCreationTokens: 300_000n, cacheCreationUsd: 6,
            }),
        ]);
    });

describe("cache-bust model + fetchCacheBustCost over a published snapshot", () => {
    dtest("derives priced busts and rolls them up with a filtering window", async () => {
        const dir = tempDir("cache-bust-cost");
        let first: CacheBustModelStats | undefined;
        let second: CacheBustModelStats | undefined;
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* seedFixture(write);
                    // First run: no marker yet -> version cutover, unwindowed.
                    first = yield* runCacheBustModels(write, 30);
                    // Second run: marker matches -> windowed, idempotent UPSERT.
                    second = yield* runCacheBustModels(write, 30);
                }),
            ),
        );
        expect(first?.rebuilt).toBe(true);
        expect(first?.written).toBe(3);
        expect(second?.rebuilt).toBe(false);
        // The windowed re-run re-upserts the in-window busts only (the 60-day
        // row falls outside the 30-day model window).
        expect(second?.written).toBe(2);

        const layer = readFixture(fixture.snapshotPath, dylibPath);
        const { week, quarter } = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return {
                    week: yield* fetchCacheBustCost(read, { sinceDays: 7, limit: 20 }),
                    quarter: yield* fetchCacheBustCost(read, { sinceDays: 90, limit: 20 }),
                };
            }).pipe(Effect.provide(layer)),
        );

        expect(week.reasons).toEqual([
            { reason: "messages_changed", busts: 1, sessions: 1, tokens: 1_000_000, costUsd: 20 },
            { reason: "previous_message_not_found", busts: 1, sessions: 1, tokens: 200_000, costUsd: 4 },
        ]);
        expect(week.skills).toEqual([
            { name: "superpowers:subagent-driven-development", busts: 1, sessions: 1, costUsd: 20 },
        ]);
        expect(week.agents).toEqual([
            { name: "design-curator", busts: 1, sessions: 1, costUsd: 4 },
        ]);

        // Coverage: 4 claude rows in-window... 3 in the 7d window (ttu:old is
        // out), 2 busted; codex excluded from the denominator.
        expect(week.coverage).toEqual({
            totalTurns: 3,
            bustTurns: 2,
            totalCacheCreationUsd: 34,
            bustCostUsd: 24,
        });

        // Corroboration only sums the bust whose model_ref resolves a rate.
        expect(week.corroboration.comparableBusts).toBe(1);
        expect(week.corroboration.costUsd).toBe(20);
        expect(week.corroboration.corroboratedUsd).toBeCloseTo(18.75, 10);

        // The wider window picks up the 60-day-old bust.
        expect(quarter.reasons[0]).toEqual({
            reason: "messages_changed", busts: 2, sessions: 1, tokens: 1_100_000, costUsd: 22,
        });
        expect(quarter.coverage.bustTurns).toBe(3);
    });
});
