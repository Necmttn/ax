/**
 * Ingest staleness rules, shared by every surface that judges "is the graph
 * current?" - `ax doctor`'s HTTP probe (cli/install.ts), the ingest-start +
 * daemon reapers (ingest/reap-runs.ts, dashboard/reap-loop.ts), and the
 * read-command warning (queries/ingest-staleness.ts).
 *
 * Two distinct questions live here on purpose - they are the same subject
 * (#697) and drifted apart once already:
 *  - {@link isStrandedRun}: is THIS "running" row a crash leftover?
 *  - {@link formatStaleIngestWarning}: is the graph as a whole out of date?
 *
 * Dep-free (no Effect, no DB) so doctor's no-layer code path and the site can
 * both import it.
 */

/** The `ingest_run` columns the stranded check reads. Shape is shared by
 *  doctor's raw HTTP probe and the reaper's SurrealClient query. */
export interface IngestRunHeartbeatRow {
    readonly id?: unknown;
    readonly started_at?: unknown;
    readonly last_progress_at?: unknown;
}

/** Grace beyond the ingest timeout before a still-"running" row is deemed
 *  stranded. Doctor, the ingest-start reaper and the daemon reaper share it so
 *  they can never disagree about what "stuck" means. */
export const REAP_GRACE_SECONDS = 60;

/**
 * Is this "running" row crash residue? Every clean exit path (ok / error /
 * interrupt / timeout) settles the row, so a row whose newest heartbeat
 * (`last_progress_at`, else `started_at`) is past the budget was killed
 * without finalizing. No parseable timestamp => can't prove it's live => treat
 * as stranded.
 */
export const isStrandedRun = (
    row: IngestRunHeartbeatRow,
    nowMs: number,
    staleAfterMs: number,
): boolean => {
    const beat = Date.parse(String(row.last_progress_at ?? row.started_at ?? ""));
    if (!Number.isFinite(beat)) return true;
    return nowMs - beat > staleAfterMs;
};

/** Age past which the graph is called stale on read commands (#697: two weeks
 *  of empty `ax cost` / `ax dispatches` went unflagged). */
export const STALE_INGEST_AFTER_HOURS = 48;

/** `50h` / `13d` - days once we're past three days, where "13d" reads better
 *  than three-digit hour counts. (Not the same 48h as {@link STALE_INGEST_AFTER_HOURS}:
 *  that's when the warning starts firing at all; this is purely about when the
 *  *display* switches units, a day later so hours right after the threshold
 *  still read precisely.) */
const formatAge = (ageMs: number): string => {
    const hours = Math.floor(ageMs / 3_600_000);
    return hours >= 72 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
};

/**
 * One-line warning for a stale graph, or null when it's current (or the check
 * is disabled with a non-positive threshold).
 *
 * `lastOkMs` is the newest run that finished with status "ok". Deliberately
 * NOT "ok or partial": the reaper settles crash residue as "partial", so
 * counting partials would let the ghost rows from #697 suppress the very
 * warning that exists to surface them.
 */
export const formatStaleIngestWarning = (input: {
    readonly lastOkMs: number | null;
    readonly nowMs: number;
    readonly thresholdMs: number;
}): string | null => {
    if (input.thresholdMs <= 0) return null;
    if (input.lastOkMs === null) {
        return "ax: no successful ingest recorded - results are empty until you run 'ax ingest'.";
    }
    const ageMs = input.nowMs - input.lastOkMs;
    if (ageMs <= input.thresholdMs) return null;
    return `ax: graph is stale - last successful ingest ${formatAge(ageMs)} ago; ` +
        `results may be incomplete. Run 'ax ingest' ('ax doctor' to diagnose).`;
};
