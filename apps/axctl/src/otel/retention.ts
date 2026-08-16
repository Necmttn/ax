import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";

const OTEL_TABLES = ["otel_metric_point", "otel_span", "otel_log_event"] as const;
const CountRow = Schema.Struct({ count: NumberFromBigIntColumn });

export interface OtelRetentionResult {
    readonly deletedByTable: Record<string, number>;
    readonly deletedEdges: number;
}

/** Keep 30 days of OTLP rows and remove relation rows without a target. */
export const retainRecentOtel = Effect.fn("otel.retention")(function* (write: CacheWriteService) {
    // The CAST is load-bearing: `CURRENT_TIMESTAMP` is TIMESTAMPTZ, and
    // TIMESTAMPTZ - INTERVAL is resolved by the ICU extension, which the shipped
    // static build does not carry - so the uncast form is a binder error there.
    // `observed_at` is a naive UTC TIMESTAMP (schema.duckdb.sql UTC CONTRACT) and
    // the seam pins connections to UTC, so the cast preserves meaning.
    const cutoff = "CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - INTERVAL '30 days'";
    const deletedByTable: Record<string, number> = {};
    for (const table of OTEL_TABLES) {
        const rows = yield* write.rows(
            CountRow,
            `SELECT count(*) AS count FROM ${table} WHERE observed_at < ${cutoff}`,
        );
        deletedByTable[table] = rows[0]?.count ?? 0;
        yield* write.exec(
            `DELETE FROM ${table} WHERE observed_at < ${cutoff}`,
        );
    }

    const dangling = `NOT EXISTS (
        SELECT 1 FROM otel_metric_point m WHERE t.out_table = 'otel_metric_point' AND m.id = t.out_id
    ) AND NOT EXISTS (
        SELECT 1 FROM otel_span s WHERE t.out_table = 'otel_span' AND s.id = t.out_id
    ) AND NOT EXISTS (
        SELECT 1 FROM otel_log_event l WHERE t.out_table = 'otel_log_event' AND l.id = t.out_id
    )`;
    const edgeRows = yield* write.rows(CountRow, `SELECT count(*) AS count FROM telemetry_of t WHERE ${dangling}`);
    const deletedEdges = edgeRows[0]?.count ?? 0;
    yield* write.exec(`DELETE FROM telemetry_of t WHERE ${dangling}`);
    return { deletedByTable, deletedEdges } satisfies OtelRetentionResult;
});

export type OtelRetentionError = CacheWriteError;
