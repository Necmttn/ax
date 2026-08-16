import { beforeEach, describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { _resetBaselineCacheForTests } from "./session-baselines.ts";
import { fetchSessionInsights } from "./session-insights.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session insights");
const SID = "aaaaaaaa-0000-0000-0000-000000000001";

beforeEach(_resetBaselineCacheForTests);

describe("fetchSessionInsights", () => {
    dtest("reads aggregate rows and maps cache dates to ISO strings", async () => {
        const t0 = new Date("2026-08-15T01:00:00Z");
        const t1 = new Date("2026-08-15T01:05:00Z");
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-insights-"), dylibPath, (db) => Effect.gen(function* () {
            yield* db.put("session", { id: SID, source: "claude", started_at: t0 });
            yield* db.put("session_metrics", { id: "m1", session: SID, lines_added: 20, lines_removed: 4, durability_ratio: 0.8, delegation_ratio: 0.25, time_to_land_ms: 200, ts: t1 });
            yield* db.put("session_token_usage", { id: "u1", session: SID, source: "claude", estimated_tokens: 350, transcript_bytes: 1, context_window: 200_000, cache_read_input_tokens: 100, prompt_tokens: 50, estimated_cost_usd: 11.2, ts: t1 });
            yield* db.put("session_health", { id: "h1", session: SID, source: "claude", turns: 2, tool_errors: 5, user_corrections: 2, ts: t1 });
            yield* db.putMany("turn_token_usage", [
                { id: "tu1", session: SID, turn: "t1", seq: 1, source: "claude", estimated_tokens: 1000, usage_source: "test", usage_quality: "exact", prompt_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ts: t0 },
                { id: "tu2", session: SID, turn: "t2", seq: 2, source: "claude", estimated_tokens: 5500, usage_source: "test", usage_quality: "exact", prompt_tokens: 4000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, ts: t1 },
            ]);
            yield* db.put("compaction", { id: "c1", session: SID, harness: "claude", ts: new Date("2026-08-15T01:40:00Z"), strategy: "summarize", source_confidence: "explicit", summary: "compact" });
        })));
        const payload = await readThroughFixture(fixture, dylibPath, fetchSessionInsights(SID));
        expect(payload.loc).toEqual({ added: 20, removed: 4 });
        expect(payload.context_curve).toEqual([{ t: 0, pct: 0.005 }, { t: 300_000, pct: 0.0275 }]);
        expect(payload.compactions).toEqual([{ ts: "2026-08-15T01:40:00.000Z", t: 300_000 }]);
        expect(payload.baseline.cache_pct).toBe(100 / 350);
    });

    dtest("returns empty sections for an unknown session", async () => {
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-insights-empty-"), dylibPath, () => Effect.void));
        const payload = await readThroughFixture(fixture, dylibPath, fetchSessionInsights(SID));
        expect(payload).toMatchObject({ session: SID, phases: [], commits: [], skills: [], context_curve: [], compactions: [] });
    });
});
