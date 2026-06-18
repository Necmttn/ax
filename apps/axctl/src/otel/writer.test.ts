import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { OtelWriter, OtelWriterLive } from "./writer.ts";
import type { OtelMetricPointRow, OtelSpanRow } from "./rows.ts";
import type { OtelLogEventRow } from "./rows.ts";

const captured: string[] = [];
const stubDb = Layer.succeed(SurrealClient, {
    query: <T>(sql: string) => { captured.push(sql); return Effect.succeed([[]] as unknown as T); },
} as never);
const writerEnv = OtelWriterLive.pipe(Layer.provide(stubDb));

const row: OtelMetricPointRow = {
    harness: "claude", metric: "claude_code.cost.usage", value: 0.12, unit: "USD",
    session_id: "s1", model: "opus", skill_name: null, agent_name: null,
    attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
};

const span: OtelSpanRow = {
    harness: "codex", name: "session_loop", trace_id: "aa", span_id: "bb",
    parent_span_id: null, session_id: "cdx1",
    started_at: new Date("2026-06-15T00:00:00Z"), ended_at: new Date("2026-06-15T00:00:01Z"),
    duration_ms: 1000, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
};

describe("OtelWriter", () => {
    test("writeMetrics issues an UPSERT into otel_metric_point", async () => {
        captured.length = 0;
        await Effect.runPromise(
            Effect.gen(function* () {
                const w = yield* OtelWriter;
                yield* w.writeMetrics([row]);
            }).pipe(Effect.provide(writerEnv)),
        );
        const sql = captured.join("\n");
        expect(sql).toContain("UPSERT otel_metric_point:");
        expect(sql).toContain("claude_code.cost.usage");
        expect(sql).toContain("value = 0.12");
    });

    test("writeSpans issues an UPSERT into otel_span", async () => {
        captured.length = 0;
        await Effect.runPromise(
            Effect.gen(function* () {
                const w = yield* OtelWriter;
                yield* w.writeSpans([span]);
            }).pipe(Effect.provide(writerEnv)),
        );
        const sql = captured.join("\n");
        expect(sql).toContain("UPSERT otel_span:");
        expect(sql).toContain("session_loop");
    });

    test("empty input issues no query", async () => {
        captured.length = 0;
        await Effect.runPromise(
            Effect.gen(function* () {
                const w = yield* OtelWriter;
                yield* w.writeMetrics([]);
            }).pipe(Effect.provide(writerEnv)),
        );
        expect(captured).toHaveLength(0);
    });
});

test("writeLogs issues an UPSERT into otel_log_event with token cols", async () => {
    captured.length = 0;
    const row: OtelLogEventRow = {
        harness: "codex", event_name: "codex.sse_event", session_id: "c1", model: "gpt-5.5",
        input_tokens: 9994, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, tool_tokens: 9994,
        duration_ms: null, status_code: null, attrs: null, observed_at: new Date("2026-06-15T00:00:00Z"),
    };
    await Effect.runPromise(Effect.gen(function* () {
        const w = yield* OtelWriter; yield* w.writeLogs([row]);
    }).pipe(Effect.provide(writerEnv)));
    const sql = captured.join("\n");
    expect(sql).toContain("UPSERT otel_log_event:");
    expect(sql).toContain("input_tokens = 9994");
});

test("writeLogs empty → no query", async () => {
    captured.length = 0;
    await Effect.runPromise(Effect.gen(function* () {
        const w = yield* OtelWriter; yield* w.writeLogs([]);
    }).pipe(Effect.provide(writerEnv)));
    expect(captured).toHaveLength(0);
});
