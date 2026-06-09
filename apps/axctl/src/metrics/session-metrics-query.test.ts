import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { fetchSessionMetrics } from "./session-metrics-query.ts";
import { SurrealClient } from "@ax/lib/db";

const db = (rows: Array<Record<string, unknown>>) =>
    Layer.succeed(SurrealClient, { query: <T>(_s: string) => Effect.succeed([rows] as unknown as T) } as never);

describe("fetchSessionMetrics", () => {
    test("maps joined rows into typed SessionMetricsRow[]", async () => {
        const rows = [{
            session: "session:`s1`", task_label: "add login", source: "claude",
            durability_ratio: 0.75, produced_commits: 4, time_to_land_ms: 3600000,
            lines_added: 120, lines_removed: 30, estimated_cost_usd: 0.42, user_corrections: 1,
        }];
        const out = await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db(rows))));
        expect(out[0]).toMatchObject({
            session: "session:`s1`", taskLabel: "add login", durabilityRatio: 0.75,
            producedCommits: 4, timeToLandMs: 3600000, linesAdded: 120, linesRemoved: 30,
            estimatedCostUsd: 0.42, userCorrections: 1, source: "claude",
        });
    });
    test("null/missing numeric fields map to null (durability/ttl/cost) or 0 (counts)", async () => {
        const rows = [{ session: "session:`s2`", durability_ratio: null, time_to_land_ms: null, produced_commits: 0, lines_added: 0, lines_removed: 0 }];
        const out = await Effect.runPromise(fetchSessionMetrics({ since: null, limit: 50 }).pipe(Effect.provide(db(rows))));
        expect(out[0].durabilityRatio).toBe(null);
        expect(out[0].timeToLandMs).toBe(null);
        expect(out[0].estimatedCostUsd).toBe(null);
        expect(out[0].producedCommits).toBe(0);
    });
});
