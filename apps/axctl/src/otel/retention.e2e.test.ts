import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { retainRecentOtel } from "./retention.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("OTLP retention", { requireFts: true });

describe("OTLP retention on real DuckDB", () => {
    dtest("removes old rows and dangling telemetry edges", async () => {
        let result: unknown;
        let remaining: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-retention-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const recent = new Date();
                const old = new Date(recent.getTime() - 31 * 86_400_000);
                yield* write.putMany("otel_metric_point", [
                    { id: "old", harness: "test", metric: "test", value: 1, observed_at: old },
                    { id: "recent", harness: "test", metric: "test", value: 1, observed_at: recent },
                ]);
                yield* write.putMany("telemetry_of", [
                    { id: "old-edge", in_id: "session", out_id: "old", out_table: "otel_metric_point" },
                    { id: "recent-edge", in_id: "session", out_id: "recent", out_table: "otel_metric_point" },
                ]);
                result = yield* retainRecentOtel(write);
                remaining = (yield* write.rows(Schema.Struct({
                    points: Schema.Number,
                    edges: Schema.Number,
                }), `SELECT
                    (SELECT count(*)::INTEGER FROM otel_metric_point) AS points,
                    (SELECT count(*)::INTEGER FROM telemetry_of) AS edges`))[0];
            }),
        ));
        expect(result).toEqual({
            deletedByTable: { otel_metric_point: 1, otel_span: 0, otel_log_event: 0 },
            deletedEdges: 1,
        });
        expect(remaining).toEqual({ points: 1, edges: 1 });
    });
});
