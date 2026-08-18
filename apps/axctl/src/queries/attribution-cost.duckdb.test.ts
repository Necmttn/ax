/**
 * `fetchAttributionCost` (#867) against a REAL published DuckDB snapshot.
 *
 * Pins three things a mocked seam cannot see:
 *  1. The window bound actually FILTERS (one row is seeded 60 days back and
 *     the same read runs at two widths).
 *  2. Non-claude sources are excluded - a codex usage row must not leak into
 *     the coverage denominator, or attribution coverage reads artificially low.
 *  3. FILTER-clause coverage math: attributed vs total rows/cost.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { fetchAttributionCost } from "./attribution-cost.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("attribution cost", { requireFts: true });

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
    readonly costUsd: number;
    readonly skill?: string | null;
    readonly agent?: string | null;
    readonly cacheMiss?: string | null;
    readonly apiError?: string | null;
}

const usageRow = (seed: UsageSeed) => ({
    id: seed.id,
    session: seed.session,
    turn: seed.id,
    seq: seed.seq,
    source: seed.source,
    model: "claude-opus-4-8",
    prompt_tokens: 1000n,
    completion_tokens: 100n,
    cache_creation_input_tokens: 0n,
    cache_read_input_tokens: 0n,
    fresh_input_tokens: 1000n,
    estimated_tokens: 1100n,
    estimated_cost_usd: seed.costUsd,
    usage_source: "claude_transcript.message_usage",
    usage_quality: "provider_turn",
    attribution_skill: seed.skill ?? null,
    attribution_agent: seed.agent ?? null,
    cache_miss_reason_type: seed.cacheMiss ?? null,
    api_error_status: seed.apiError ?? null,
    ts: seed.ts,
});

describe("fetchAttributionCost over a published snapshot", () => {
    dtest("rolls up native attribution with a filtering window and claude-only coverage", async () => {
        const dir = tempDir("attribution-cost");
        const fixture = await runWithPlatform(
            publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    // Two attributed skill rows in-window, distinct sessions.
                    yield* write.put("turn_token_usage", usageRow({
                        id: "ttu:1", session: SESSION_A, seq: 1, ts: hoursAgo(2),
                        source: "claude", costUsd: 2, skill: "artifact-design",
                        cacheMiss: "previous_message_not_found",
                    }));
                    yield* write.put("turn_token_usage", usageRow({
                        id: "ttu:2", session: SESSION_B, seq: 1, ts: hoursAgo(3),
                        source: "claude-subagent", costUsd: 1, skill: "artifact-design",
                        agent: "design-curator", apiError: "529",
                    }));
                    // Unattributed claude row - counts in coverage denominator only.
                    yield* write.put("turn_token_usage", usageRow({
                        id: "ttu:3", session: SESSION_A, seq: 2, ts: hoursAgo(4),
                        source: "claude", costUsd: 4,
                    }));
                    // OUTSIDE the 7-day window - proves the bound filters.
                    yield* write.put("turn_token_usage", usageRow({
                        id: "ttu:old", session: SESSION_A, seq: 3, ts: daysAgo(60),
                        source: "claude", costUsd: 50, skill: "artifact-design",
                    }));
                    // A codex row with attribution-shaped nulls - must not
                    // enter the claude coverage denominator.
                    yield* write.put("turn_token_usage", usageRow({
                        id: "ttu:codex", session: SESSION_B, seq: 4, ts: hoursAgo(1),
                        source: "codex", costUsd: 9,
                    }));
                }),
            ),
        );
        const layer = readFixture(fixture.snapshotPath, dylibPath);

        const { week, quarter } = await Effect.runPromise(
            Effect.gen(function* () {
                const read = yield* CacheRead;
                return {
                    week: yield* fetchAttributionCost(read, { sinceDays: 7, limit: 20 }),
                    quarter: yield* fetchAttributionCost(read, { sinceDays: 90, limit: 20 }),
                };
            }).pipe(Effect.provide(layer)),
        );

        // Skill rollup: 2 in-window turns across 2 sessions, $3.
        expect(week.skills).toEqual([
            { name: "artifact-design", turns: 2, sessions: 2, costUsd: 3, tokens: 2200 },
        ]);
        expect(week.agents).toEqual([
            { name: "design-curator", turns: 1, sessions: 1, costUsd: 1, tokens: 1100 },
        ]);
        expect(week.cacheMissReasons).toEqual([{ reason: "previous_message_not_found", turns: 1 }]);
        expect(week.apiErrors).toEqual([{ status: "529", turns: 1 }]);

        // Coverage: 3 claude rows in-window (codex excluded), 2 attributed.
        expect(week.coverage).toEqual({
            totalTurns: 3,
            attributedTurns: 2,
            totalCostUsd: 7,
            attributedCostUsd: 3,
        });

        // The wider window picks up the 60-day-old row.
        expect(quarter.skills[0]?.turns).toBe(3);
        expect(quarter.skills[0]?.costUsd).toBe(53);
    });
});
