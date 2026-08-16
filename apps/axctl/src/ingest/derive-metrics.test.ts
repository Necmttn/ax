import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { deriveMetrics, deriveMetricsStage } from "./derive-metrics.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("derived metrics", { requireFts: true });

describe("deriveMetrics on real DuckDB", () => {
    dtest("handles an empty cache and writes no metric rows", async () => {
        let stats: unknown;
        let count = -1;
        await runWithPlatform(publishCacheFixture(tempDir("ax-metrics-empty-"), dylibPath, (write) =>
            Effect.gen(function* () {
                stats = yield* deriveMetrics(write, { sinceDays: 1 });
                count = (yield* write.rows(Schema.Struct({ count: Schema.Number }),
                    "SELECT count(*)::INTEGER AS count FROM session_metrics"))[0]!.count;
            }),
        ));
        expect(stats).toEqual({ sessionsWritten: 0, revertedCommits: 0, cascadeEdges: 0, costBackfilled: 0 });
        expect(count).toBe(0);
    });

    dtest("writes a recent session rollup and backfills its cost", async () => {
        let stats: unknown;
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-metrics-session-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("session", { id: "s1", source: "claude", started_at: new Date() });
                yield* write.put("session_token_usage", {
                    id: "usage-s1", session: "s1", source: "claude", model: "claude-opus-4-5",
                    estimated_tokens: 1_000_000, transcript_bytes: 4_000_000,
                });
                stats = yield* deriveMetrics(write, { sinceDays: 1 });
                row = (yield* write.rows(Schema.Struct({
                    session: Schema.String,
                    lines_added: Schema.Number,
                    cold_start_reads: Schema.Number,
                    cost: Schema.Number,
                }), `SELECT m.session, m.lines_added::INTEGER AS lines_added,
                    m.cold_start_reads::INTEGER AS cold_start_reads,
                    (SELECT estimated_cost_usd FROM session_token_usage WHERE session = m.session) AS cost
                    FROM session_metrics m WHERE m.session = ?`, ["s1"]))[0];
            }),
        ));
        expect(stats).toMatchObject({ sessionsWritten: 1, cascadeEdges: 0, costBackfilled: 1 });
        expect(row).toEqual({ session: "s1", lines_added: 0, cold_start_reads: 0, cost: 5 });
    });
});

describe("deriveMetricsStage", () => {
    dtest("keeps the required stage order", () => {
        expect(deriveMetricsStage.meta.key).toBe("derive-metrics");
        expect(deriveMetricsStage.meta.deps).toEqual(["git", "session-health", "spawned"]);
    });
});
