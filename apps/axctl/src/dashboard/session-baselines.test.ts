import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import {
    _resetBaselineCacheForTests,
    fetchSessionBaselines,
    median,
    p90,
} from "./session-baselines.ts";

const run = (stub: SurrealClientShape) =>
    Effect.runPromise(
        fetchSessionBaselines().pipe(Effect.provideService(SurrealClient, stub)),
    );

describe("session baseline math", () => {
    test("median handles odd, even, and empty inputs", () => {
        expect(median([9, 1, 5])).toBe(5);
        expect(median([10, 2, 4, 8])).toBe(6);
        expect(median([])).toBeNull();
    });

    test("p90 uses nearest-rank and returns null for empty input", () => {
        expect(p90(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(90);
        expect(p90([])).toBeNull();
    });
});

describe("fetchSessionBaselines", () => {
    test("computes medians and burn p90 from one aggregate query and caches", async () => {
        _resetBaselineCacheForTests();
        const tc = makeTestSurrealClient({
            denyWrites: true,
            responses: [[
                [{ estimated_cost_usd: 3 }, { estimated_cost_usd: 1 }, { estimated_cost_usd: 5 }],
                [{ friction: 6 }, { friction: 2 }],
                [{ time_to_land_ms: 1000 }, { time_to_land_ms: 5000 }],
                [
                    { estimated_tokens: 1000, turns: 10 },
                    { estimated_tokens: 9000, turns: 9 },
                    { estimated_tokens: 1, turns: 0 },
                ],
            ]],
        });

        const first = await run(tc.client);
        const second = await run(tc.client);

        expect(first).toEqual({
            median_cost_usd: 3,
            median_friction: 4,
            median_time_to_land_ms: 3000,
            burn_p90: 1000,
        });
        expect(second).toEqual(first);
        expect(tc.captured).toHaveLength(1);
    });

    test("baseline query is one flat multi-statement query over aggregate tables", async () => {
        _resetBaselineCacheForTests();
        const tc = makeTestSurrealClient({
            denyWrites: true,
            responses: [[[{ estimated_cost_usd: 1 }], [{ friction: 0 }], [{ time_to_land_ms: 1 }], [{ estimated_tokens: 1, turns: 1 }]]],
        });

        await run(tc.client);

        expect(tc.captured).toHaveLength(1);
        const sql = tc.captured[0]!;
        expect(sql).toContain("FROM session_token_usage");
        expect(sql).toContain("FROM session_health");
        expect(sql).toContain("FROM session_metrics");
        // session_metrics uses table-own ts field (no per-row deref)
        expect(sql).toContain("WHERE ts > time::now() - 30d");
        // zero-token sessions excluded from burn p90
        expect(sql).toContain("AND estimated_tokens > 0");
        // guard: no per-row record deref in any baseline statement
        expect(sql).not.toContain("session.");
        expect(sql).not.toMatch(/FROM turn\b/);
        expect(sql).not.toContain("turn_token_usage");
        expect((sql.match(/SELECT/g) ?? []).length).toBe(4);
    });
});
