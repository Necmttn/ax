import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { sessionTelemetryCost, sessionTelemetryLatency } from "./telemetry-rollup.ts";

const db = (rows: { metric?: unknown[]; log?: unknown[] }) =>
    Layer.succeed(SurrealClient, {
        query: <T>(sql: string) => {
            if (/FROM otel_metric_point/.test(sql)) return Effect.succeed([rows.metric ?? []] as unknown as T);
            if (/FROM otel_log_event/.test(sql)) return Effect.succeed([rows.log ?? []] as unknown as T);
            return Effect.succeed([[]] as unknown as T);
        },
    } as never);
const run = <A>(e: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(e.pipe(Effect.provide(layer)));

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
