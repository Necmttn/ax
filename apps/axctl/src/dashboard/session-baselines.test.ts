import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { publishCacheFixture, readThroughFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { _resetBaselineCacheForTests, fetchSessionBaselines, median, p90 } from "./session-baselines.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session baselines");

describe("session baseline math", () => {
    dtest("computes medians and burn p90 from real DuckDB rows", async () => {
        expect(median([9, 1, 5])).toBe(5);
        expect(median([10, 2, 4, 8])).toBe(6);
        expect(p90(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(90);
        _resetBaselineCacheForTests();
        const now = new Date();
        const fixture = await runWithPlatform(publishCacheFixture(tempDir("ax-baselines-"), dylibPath, (db) => Effect.gen(function* () {
            for (let i = 1; i <= 3; i += 1) yield* db.put("session", { id: `s${i}`, source: "claude" });
            yield* db.putMany("session_token_usage", [
                { id: "u1", session: "s1", source: "claude", estimated_tokens: 1000, transcript_bytes: 1, estimated_cost_usd: 3, ts: now },
                { id: "u2", session: "s2", source: "claude", estimated_tokens: 9000, transcript_bytes: 1, estimated_cost_usd: 1, ts: now },
                { id: "u3", session: "s3", source: "claude", estimated_tokens: 5000, transcript_bytes: 1, estimated_cost_usd: 5, ts: now },
            ]);
            yield* db.putMany("session_health", [
                { id: "h1", session: "s1", source: "claude", turns: 10, estimated_tokens: 1000, tool_errors: 2, user_corrections: 4, ts: now },
                { id: "h2", session: "s2", source: "claude", turns: 9, estimated_tokens: 9000, tool_errors: 1, user_corrections: 1, ts: now },
            ]);
            yield* db.putMany("session_metrics", [
                { id: "m1", session: "s1", time_to_land_ms: 1000, ts: now },
                { id: "m2", session: "s2", time_to_land_ms: 5000, ts: now },
            ]);
        })));
        const value = await readThroughFixture(fixture, dylibPath, fetchSessionBaselines());
        expect(value).toEqual({ median_cost_usd: 3, median_friction: 4, median_time_to_land_ms: 3000, burn_p90: 1000 });
    });
});
