import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { retainRecentOtel } from "./retention.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("OTLP retention", { requireFts: true });

describe("retainRecentOtel with real DuckDB", () => {
    dtest("removes old rows and dangling edges", async () => {
        let result: Record<string, unknown> = {};
        await runWithPlatform(publishCacheFixture(tempDir("ax-otel-retention-"), dylibPath, (write) =>
            Effect.gen(function* () {
                const old = new Date(Date.now() - 40 * 86_400_000);
                const recent = new Date();
                yield* write.putMany("otel_metric_point", [
                    { id: "old", harness: "claude", metric: "cost", value: 1, observed_at: old },
                    { id: "recent", harness: "claude", metric: "cost", value: 2, observed_at: recent },
                ]);
                yield* write.putMany("telemetry_of", [
                    { id: "edge-old", in_id: "session-1", out_id: "old", out_table: "otel_metric_point", linked_at: old },
                    { id: "edge-missing", in_id: "session-2", out_id: "missing", out_table: "otel_metric_point", linked_at: recent },
                    { id: "edge-recent", in_id: "session-3", out_id: "recent", out_table: "otel_metric_point", linked_at: recent },
                ]);
                const deleted = yield* retainRecentOtel(write);
                const counts = yield* write.rows(
                    Schema.Struct({ metrics: Schema.BigInt, edges: Schema.BigInt }),
                    `SELECT (SELECT count(*) FROM otel_metric_point) AS metrics,
                            (SELECT count(*) FROM telemetry_of) AS edges`,
                );
                result = { deleted, counts: counts[0] };
            }),
        ));

        expect(result.deleted).toEqual({
            deletedByTable: { otel_metric_point: 1, otel_span: 0, otel_log_event: 0 },
            deletedEdges: 2,
        });
        expect(result.counts).toEqual({ metrics: 1n, edges: 1n });
    });
});
