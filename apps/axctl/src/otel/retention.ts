import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";

const OTEL_TABLES = ["otel_metric_point", "otel_span", "otel_log_event"] as const;

export interface OtelRetentionResult {
    /** Rows pruned per otel table (best-effort count via a pre-delete SELECT count()). */
    readonly deletedByTable: Record<string, number>;
    /** Dangling `telemetry_of` edges pruned after their otel target was deleted. */
    readonly deletedEdges: number;
}

/**
 * Keep only the latest 30 days of stored OTLP rows, then prune any
 * `telemetry_of` edge left dangling by that delete so enrichment joins
 * (`telemetry-rollup.ts`) never dereference a record that no longer exists.
 *
 * DELETE FORM: the subquery RESULT is deleted (`DELETE (SELECT VALUE id ...)`),
 * never `DELETE ... WHERE id IN (SELECT ...)`. The id-IN-subquery form is
 * planned as a per-row membership test - the inner full-table scan
 * re-evaluates for every candidate row, going quadratic in table size. That
 * exact quadratic form wedged `agent_event`/`agent_event_child` deletes at
 * ~460k rows (see the doc comment on
 * `buildAgentSessionEventClearStatements` in
 * `apps/axctl/src/ingest/provider-events.ts`); `otel_log_event` alone holds
 * ~1.5M rows, so it would hit the same wall.
 */
export const retainRecentOtel = Effect.fn("otel.retention")(function* () {
    const db = yield* SurrealClient;
    const deletedByTable: Record<string, number> = {};

    for (const table of OTEL_TABLES) {
        // Best-effort pre-delete count for the run summary (F5/F6
        // observability) - counted under the same predicate the delete uses,
        // just before it runs.
        const [countRows] = yield* db.query<[Array<{ count: number }>]>(
            `SELECT count() FROM ${table} WHERE observed_at < time::now() - 30d GROUP ALL;`,
        );
        deletedByTable[table] = countRows?.[0]?.count ?? 0;

        yield* db.query(
            `DELETE (SELECT VALUE id FROM ${table} WHERE observed_at < time::now() - 30d);`,
        );
    }

    // Belt-and-suspenders: SurrealDB 3.0.x was observed (via a live e2e
    // check, see retention.e2e.test.ts) to auto-drop a `telemetry_of` edge
    // as soon as its `out` otel row is deleted above, so this is usually a
    // no-op. It stays as defense-in-depth for edges that predate that
    // behavior (e.g. rows written before this fix shipped) or that arrive
    // via a path that doesn't cascade. `out.id IS NONE` dereferences the
    // target; it evaluates to NONE once the target record no longer exists.
    const [edgeCountRows] = yield* db.query<[Array<{ count: number }>]>(
        "SELECT count() FROM telemetry_of WHERE out.id IS NONE GROUP ALL;",
    );
    const deletedEdges = edgeCountRows?.[0]?.count ?? 0;

    yield* db.query("DELETE (SELECT VALUE id FROM telemetry_of WHERE out.id IS NONE);");

    return { deletedByTable, deletedEdges } satisfies OtelRetentionResult;
});
