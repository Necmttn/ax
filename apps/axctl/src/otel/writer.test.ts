import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { OtelWriter, OtelWriterLive } from "./writer.ts";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("OTLP writers", { requireFts: true });
const at = new Date("2026-06-15T00:00:00Z");

describe("OTLP writers on real DuckDB", () => {
    dtest("writes metric, span, and log values with null and zero intact", async () => {
        let row: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-writer-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const writer = yield* OtelWriter;
                yield* writer.writeMetrics([{
                    harness: "claude", metric: "claude_code.cost.usage", value: 0.12, unit: "USD",
                    session_id: "s1", model: null, skill_name: null, agent_name: null,
                    attrs: "{\"a\":1}", observed_at: at,
                }]);
                yield* writer.writeSpans([{
                    harness: "codex", name: "session_loop", trace_id: "aa", span_id: "bb",
                    parent_span_id: null, session_id: "s1", started_at: at, ended_at: at,
                    duration_ms: 0, attrs: null, observed_at: at,
                }]);
                yield* writer.writeLogs([{
                    harness: "codex", event_name: "token_usage", session_id: "s1", model: "gpt-5.5",
                    input_tokens: 9994, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0,
                    tool_tokens: 9994, duration_ms: null, status_code: null, attrs: null, observed_at: at,
                }]);
                row = (yield* write.rows(Schema.Struct({
                    metric_value: Schema.Number, metric_model: Schema.Null,
                    span_duration: Schema.Number, span_parent: Schema.Null,
                    input_tokens: Schema.Number, output_tokens: Schema.Number,
                    log_duration: Schema.Null,
                }), `SELECT
                    (SELECT value FROM otel_metric_point LIMIT 1) AS metric_value,
                    (SELECT model FROM otel_metric_point LIMIT 1) AS metric_model,
                    (SELECT duration_ms FROM otel_span LIMIT 1) AS span_duration,
                    (SELECT parent_span_id FROM otel_span LIMIT 1) AS span_parent,
                    (SELECT input_tokens FROM otel_log_event LIMIT 1) AS input_tokens,
                    (SELECT output_tokens FROM otel_log_event LIMIT 1) AS output_tokens,
                    (SELECT duration_ms FROM otel_log_event LIMIT 1) AS log_duration`))[0];
            }).pipe(Effect.provide(OtelWriterLive(write))),
        ));
        expect(row).toEqual({
            metric_value: 0.12, metric_model: null, span_duration: 0, span_parent: null,
            input_tokens: 9994, output_tokens: 0, log_duration: null,
        });
    });
});
