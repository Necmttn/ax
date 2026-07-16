/**
 * Stale-graph warning for read commands (#697).
 *
 * `ax dispatches` / `ax cost` returned empty for two weeks while ingest was
 * dead, and nothing said so - an empty table reads as "you have no data", not
 * "your data stopped 13 days ago". Doctor knew, but only when run by hand.
 *
 * So every DB-backed command pays one indexed query (`status = 'ok'` ORDER BY
 * the indexed `started_at`, LIMIT 1) and prints at most one stderr line. It is
 * wired into `withDb` (cli/index.ts) rather than per-command, so a new read
 * command inherits it without knowing this exists.
 *
 * Fail-open: an unreachable DB prints nothing (the command's own error already
 * says that) and a warning never touches stdout, so `--json` stays machine-clean.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { nonNegativeNumberEnv } from "@ax/lib/shared/env-number";
import {
    formatStaleIngestWarning,
    STALE_INGEST_AFTER_HOURS,
} from "@ax/lib/shared/ingest-staleness";

/** Age past which the graph is called stale. `AX_STALE_INGEST_HOURS`; 0
 *  disables the warning. A blank value (unset-but-exported) falls back to
 *  the default rather than reading as an explicit 0 - see
 *  {@link nonNegativeNumberEnv}. Exported for tests. */
export const staleIngestThresholdMs = (env: NodeJS.ProcessEnv = process.env): number =>
    nonNegativeNumberEnv(env.AX_STALE_INGEST_HOURS, STALE_INGEST_AFTER_HOURS) * 3_600_000;

/** Hard cap on the probe. A wedged DB must not add latency to a command that
 *  is already failing - the warning is a courtesy, not a feature. */
const PROBE_TIMEOUT_MS = 2_000;

interface LastOkRunRow {
    readonly ended_at?: unknown;
    readonly started_at?: unknown;
}

/**
 * Epoch ms of the newest ingest that finished with status "ok", or null when
 * there is none (or its timestamps are unreadable). Hits the
 * `ingest_run_status_started` index: equality on `status`, ordered by the
 * indexed `started_at`. Reads `ended_at` as the completion instant, falling
 * back to `started_at` for rows written before `ended_at` existed.
 */
export const fetchLastSuccessfulIngestAt: Effect.Effect<number | null, DbError, SurrealClient> =
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[LastOkRunRow[]]>(
            "SELECT ended_at, started_at FROM ingest_run WHERE status = 'ok' ORDER BY started_at DESC LIMIT 1;",
        );
        const row = rows?.[0];
        if (row === undefined) return null;
        const at = Date.parse(String(row.ended_at ?? row.started_at ?? ""));
        return Number.isFinite(at) ? at : null;
    });

/**
 * Print the stale-graph warning to stderr if the graph is out of date. Never
 * fails, never throws, never writes to stdout.
 */
export const warnIfIngestStale: Effect.Effect<void, never, SurrealClient> = Effect.gen(
    function* () {
        const thresholdMs = staleIngestThresholdMs();
        if (thresholdMs <= 0) return;
        const lastOkMs = yield* fetchLastSuccessfulIngestAt;
        const warning = formatStaleIngestWarning({ lastOkMs, nowMs: Date.now(), thresholdMs });
        if (warning === null) return;
        yield* Effect.sync(() => process.stderr.write(`${warning}\n`));
    },
).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    // `ignore` only matches the error channel (E) - a defect (e.g. EPIPE from
    // process.stderr.write when a piped reader closes early, `ax cost 2>&1 |
    // head -1`) rides the Cause untouched and would fail a successful command
    // via `ensuring`. `ignoreCause` matches on the whole Cause, so defects and
    // interruptions are swallowed too - the only way to honor "never fails."
    Effect.ignoreCause,
);
