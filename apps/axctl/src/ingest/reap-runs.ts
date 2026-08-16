/**
 * Reap ingest_run rows stranded in status "running" past the ingest timeout.
 *
 * Every clean exit path (ok / error / interrupt / timeout) settles the row via
 * `withIngestRunFinish`, so a still-"running" row past the budget is crash/
 * SIGKILL residue - a lie that misleads diagnosis (doctor flags it, issue #269).
 * This finalizes each one as "partial" with a reaped marker, matching the
 * interrupt/timeout finalizer, so doctor stops warning and run history reads
 * honestly. Idempotent: a row already settled drops out of the WHERE filter.
 */
import { Effect, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { AxConfig } from "@ax/lib/config";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import {
    isStrandedRun,
    REAP_GRACE_SECONDS,
    type IngestRunHeartbeatRow,
} from "@ax/lib/shared/ingest-staleness";

/** `ingest_run:⟨id⟩` or `ingest_run:\`id\`` (SurrealDB escapes ids with special
 *  chars - e.g. a uuid's dashes - in angle brackets or backticks) -> the bare id
 *  that `buildIngestRunFinishStatement` re-wraps in backticks (an equivalent
 *  escape, so a uuid id still matches). */
const bareRunId = (id: unknown): string =>
    String(id)
        .replace(/^ingest_run:/, "")
        .replace(/^[`⟨]/, "")
        .replace(/[`⟩]$/, "");

/** Pure selector: the bare ids of rows that should be reaped. Exported for tests. */
export function selectStrandedRunIds(
    rows: readonly IngestRunHeartbeatRow[],
    nowMs: number,
    staleAfterMs: number,
): string[] {
    return rows.filter((row) => isStrandedRun(row, nowMs, staleAfterMs)).map((row) => bareRunId(row.id));
}

export interface ReapStaleRunsResult {
    /** Stranded rows found (regardless of dry-run). */
    readonly found: number;
    /** Rows actually finalized (0 on dry-run). */
    readonly reaped: number;
    /** Bare run ids that were (or would be) reaped. */
    readonly ids: ReadonlyArray<string>;
    readonly dryRun: boolean;
}

/**
 * Reap-specific terminal write. The status predicate closes the race between
 * selecting a stale "running" row and settling it: a live run that finishes
 * "ok" in that gap must not be overwritten as "partial".
 */
export function buildReapIngestRunStatement(runId: string): string {
    return `UPDATE ingest_run SET status = 'partial', ended_at = current_timestamp, metrics = ? WHERE id = ? AND status = 'running'`;
}

export const reapStaleIngestRuns = (
    write: CacheWriteService,
    opts: { readonly dryRun?: boolean } = {},
): Effect.Effect<ReapStaleRunsResult, CacheWriteError, AxConfig> =>
    Effect.gen(function* () {
        const config = yield* AxConfig;
        const staleAfterMs = (config.knobs.ingestTimeoutSeconds + REAP_GRACE_SECONDS) * 1000;
        const rows = yield* write.rows(
            Schema.Struct({
                id: Schema.String,
                started_at: TimestampColumn,
                last_progress_at: Schema.NullOr(TimestampColumn),
            }),
            "SELECT id, started_at, last_progress_at FROM ingest_run WHERE status = 'running'",
        );
        const ids = selectStrandedRunIds(rows, Date.now(), staleAfterMs);
        if (!opts.dryRun) {
            for (const runId of ids) {
                yield* write.exec(buildReapIngestRunStatement(runId), [
                    JSON.stringify({ error: "reaped: stale running past ingest timeout" }),
                    runId,
                ]);
            }
        }
        return {
            found: ids.length,
            reaped: opts.dryRun ? 0 : ids.length,
            ids,
            dryRun: opts.dryRun ?? false,
        };
    });
