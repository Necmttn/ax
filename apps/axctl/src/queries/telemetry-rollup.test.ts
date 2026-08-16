import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { makeTestCacheRead } from "@ax/lib/testing/cache";
import {
    enrichRowsWithTelemetryCost as enrichRowsWithTelemetryCostWithRead,
    enrichRowsWithTelemetryLatency as enrichRowsWithTelemetryLatencyWithRead,
    sessionTelemetryCost as sessionTelemetryCostWithRead,
    sessionTelemetryLatency as sessionTelemetryLatencyWithRead,
    type TelemetryCost,
    type TelemetryLatency,
} from "./telemetry-rollup.ts";

const db = (rows: { metric?: unknown[]; log?: unknown[] }) =>
    makeTestCacheRead({ routes: [
        { match: /FROM otel_metric_point/, rows: rows.metric ?? [] },
        { match: /FROM otel_log_event/, rows: rows.log ?? [] },
    ] }).layer;
const run = <A>(e: Effect.Effect<A, unknown, CacheRead>, layer: Layer.Layer<CacheRead>) =>
    Effect.runPromise(e.pipe(Effect.provide(layer)));
const sessionTelemetryCost = (ids: readonly string[]) => Effect.gen(function* () {
    return yield* sessionTelemetryCostWithRead(yield* CacheRead, ids);
});
const sessionTelemetryLatency = (ids: readonly string[]) => Effect.gen(function* () {
    return yield* sessionTelemetryLatencyWithRead(yield* CacheRead, ids);
});
const enrichRowsWithTelemetryCost = <Row, Out>(
    rows: ReadonlyArray<Row>, sessionOf: (row: Row) => unknown,
    merge: (row: Row, telemetry: TelemetryCost | null) => Out,
) => Effect.gen(function* () {
    return yield* enrichRowsWithTelemetryCostWithRead(yield* CacheRead, rows, sessionOf, merge);
});
const enrichRowsWithTelemetryLatency = <Row, Out>(
    rows: ReadonlyArray<Row>, sessionOf: (row: Row) => unknown,
    merge: (row: Row, telemetry: TelemetryLatency | null) => Out,
) => Effect.gen(function* () {
    return yield* enrichRowsWithTelemetryLatencyWithRead(yield* CacheRead, rows, sessionOf, merge);
});

describe("sessionTelemetryCost", () => {
    test("sums claude cost.usage → cost_usd and token.usage → tokens", async () => {
        const layer = db({ metric: [
            { session_id: "s1", metric: "claude_code.cost.usage", total: 0.5 },
            { session_id: "s1", metric: "claude_code.token.usage", total: 1200 },
        ] });
        const m = await run(sessionTelemetryCost(["s1"]), layer);
        expect(m.get("s1")?.cost_usd).toBe(0.5);
        expect(m.get("s1")?.tokens).toBe(1200);
        expect(m.get("s1")?.source).toBe("otlp");
    });
    test("codex log tokens, no cost metric → cost_usd null, tokens summed", async () => {
        const layer = db({ log: [{ session_id: "c1", i: 100, o: 50, r: 10, t: 0 }] });
        const m = await run(sessionTelemetryCost(["c1"]), layer);
        expect(m.get("c1")?.cost_usd).toBeNull();
        expect(m.get("c1")?.tokens).toBe(160);
    });
    test("no telemetry → session absent", async () => {
        const m = await run(sessionTelemetryCost(["x"]), db({}));
        expect(m.has("x")).toBe(false);
    });
    test("empty input → empty map", async () => {
        const m = await run(sessionTelemetryCost([]), db({}));
        expect(m.size).toBe(0);
    });
});
describe("sessionTelemetryLatency", () => {
    test("sums log duration_ms", async () => {
        const layer = db({ log: [{ session_id: "c1", d: 693, n: 1 }] });
        const m = await run(sessionTelemetryLatency(["c1"]), layer);
        expect(m.get("c1")?.duration_ms).toBe(693);
    });
});

describe("telemetry row enrichment", () => {
    test("cost enrichment normalizes session record ids and merges absent telemetry as null", async () => {
        const layer = db({
            metric: [
                { session_id: "s1", metric: "claude_code.cost.usage", total: 0.75 },
                { session_id: "s1", metric: "claude_code.token.usage", total: 300 },
            ],
        });
        const rows = [
            { id: "a", session: "session:s1" },
            { id: "b", session: "session:missing" },
        ] as const;
        const enriched = await run(
            enrichRowsWithTelemetryCost(
                rows,
                (row) => row.session,
                (row, cost) => ({
                    ...row,
                    otlp_cost_usd: cost?.cost_usd ?? null,
                    otlp_tokens: cost?.tokens ?? null,
                }),
            ),
            layer,
        );
        expect(enriched).toEqual([
            { id: "a", session: "session:s1", otlp_cost_usd: 0.75, otlp_tokens: 300 },
            { id: "b", session: "session:missing", otlp_cost_usd: null, otlp_tokens: null },
        ]);
    });

    test("latency enrichment hides lookup and normalization details", async () => {
        const layer = db({ log: [{ session_id: "c1", d: 42, n: 2 }] });
        const enriched = await run(
            enrichRowsWithTelemetryLatency(
                [{ session_id: "session:c1" }],
                (row) => row.session_id,
                (row, latency) => ({ ...row, recovery_ms: latency?.duration_ms ?? null }),
            ),
            layer,
        );
        expect(enriched).toEqual([{ session_id: "session:c1", recovery_ms: 42 }]);
    });
});
