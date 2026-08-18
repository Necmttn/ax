/**
 * The ingest PROGRESS LEDGER: `ingest_run` / `ingest_stage` / `ingest_event`.
 *
 * Every write here goes through `CacheWriteService` (DuckDB, under the ingest
 * lock). It used to emit raw SQL TEXT built out of string helpers, which is why
 * no port chunk ever claimed it: the module imported no client, so grepping for
 * one could not see it. A writer is found by what it emits, not by what it
 * imports. The module also moved out of `dashboard/`, where it never belonged -
 * it is written by `ingest/run.ts` and `cli/commands/ingest.ts`, and the
 * dashboard only ever READ it.
 *
 * WHY THE WRITERS LIVE HERE AND NOT AT THE TWO CALL SITES. The seam port landed
 * as inline `write.put(...)` / `write.exec(...)` blocks duplicated between
 * `ingest/run.ts` (the stage pipeline) and `cli/commands/ingest.ts` (the
 * `derive-signals` / `ingest-insights` verbs). Duplicated ledger writes drift
 * silently: this ledger is WRITE-ONLY on the CLI's happy path - nothing in `ax
 * ingest` reads `ingest_event` back - so a column that stops matching the DDL
 * costs an exit code of 0 and a Live tab that shows nothing. One implementation,
 * one place to test the decode contract.
 *
 * THE ROW-ID CONTRACT. `ingest_stage` ids are deterministic
 * (`<runId>__<source>__<stage>`, sanitized) so a stage that starts and then
 * finishes UPDATEs its own row rather than appending a second one, and a re-run
 * of the same stage in the same run is idempotent. `ingest_event` ids are
 * content-hashed over run+source+stage+message+ts, so republishing an identical
 * event collapses onto one row.
 */
import { Effect } from "effect";
import { cacheRow, jsonParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";

export type IngestEventLevel = "debug" | "info" | "warn" | "error";

export interface IngestEvent {
    readonly type: "ingest_event";
    readonly id: string;
    readonly runId: string;
    readonly source: string;
    readonly stage: string;
    readonly level: IngestEventLevel;
    readonly message: string;
    readonly counts: Record<string, number>;
    readonly ts: string;
}

/** Terminal `ingest_run` statuses: "ok" = clean finish, "error" = the run
 *  failed, "partial" = interrupted/timed out with progress saved (re-running
 *  `ax ingest` continues incrementally). "running" is never terminal - a row
 *  stuck there means the process died without finalizing (doctor warns). */
export type IngestRunFinishStatus = "ok" | "error" | "partial";

/**
 * A row id segment safe to store and to match on.
 *
 * DuckDB ids are plain strings, so this no longer guards a record-id parser -
 * it keeps the id STABLE across the two call sites (both must compute the same
 * id for a stage start and its finish to hit the same row) and bounded.
 */
const idPart = (value: string): string =>
    value.replace(/[^A-Za-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "stage";

/** The deterministic `ingest_stage` row id for one (run, source, stage). */
export const ingestStageId = (runId: string, source: string, stage: string): string =>
    `${idPart(runId)}__${idPart(source)}__${idPart(stage)}`;

export function makeIngestEvent(
    input: Omit<IngestEvent, "type" | "id" | "ts"> & { readonly ts?: string },
): IngestEvent {
    const ts = input.ts ?? new Date().toISOString();
    const id = Bun.hash(`${input.runId}|${input.source}|${input.stage}|${input.message}|${ts}`)
        .toString(16)
        .padStart(16, "0");
    return { type: "ingest_event", id, ts, ...input };
}

/**
 * Open the run's row.
 *
 * `started_at` / `last_progress_at` are stamped from THIS process's clock
 * rather than left to the DDL's `DEFAULT CURRENT_TIMESTAMP`: the seam's upsert
 * always names every column it was handed, so a default would only fire on the
 * first insert anyway, and an explicit Date makes the value testable.
 */
export const writeIngestRunStart = (
    write: CacheWriteService,
    input: {
        readonly runId: string;
        readonly command: string;
        readonly sinceDays?: number | null;
    },
): Effect.Effect<void, CacheWriteError> =>
    write.put(
        "ingest_run",
        cacheRow({
            id: input.runId,
            command: input.command,
            status: "running",
            since_days: input.sinceDays ?? null,
            started_at: new Date(),
            last_progress_at: new Date(),
            ended_at: null,
            metrics: null,
        }),
    );

/** Settle the run's row. `metrics` is JSON-encoded (the column is VARCHAR). */
export const writeIngestRunFinish = (
    write: CacheWriteService,
    input: {
        readonly runId: string;
        readonly status: IngestRunFinishStatus;
        readonly metrics?: unknown;
    },
): Effect.Effect<void, CacheWriteError> =>
    write.exec(
        "UPDATE ingest_run SET status = ?, ended_at = CURRENT_TIMESTAMP, metrics = ? WHERE id = ?",
        [input.status, jsonParam(input.metrics ?? {}), input.runId],
    ).pipe(Effect.asVoid);

/** Heartbeat on the parent run row: stage start/finish and long-running
 *  provider work loops bump `last_progress_at` so a genuinely-live "running"
 *  run is distinguishable from one stranded by a crash (doctor's stale-run
 *  check, issue #269). */
export const writeIngestRunHeartbeat = (
    write: CacheWriteService,
    runId: string,
): Effect.Effect<void, CacheWriteError> =>
    write.exec("UPDATE ingest_run SET last_progress_at = CURRENT_TIMESTAMP WHERE id = ?", [runId])
        .pipe(Effect.asVoid);

/** Open a stage row and bump the run heartbeat. */
export const writeIngestStageStart = (
    write: CacheWriteService,
    input: {
        readonly runId: string;
        readonly source: string;
        readonly stage: string;
    },
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        yield* write.put(
            "ingest_stage",
            cacheRow({
                id: ingestStageId(input.runId, input.source, input.stage),
                run: input.runId,
                source: input.source,
                stage: input.stage,
                status: "running",
                started_at: new Date(),
                ended_at: null,
                counts: null,
                error_text: null,
            }),
        );
        yield* writeIngestRunHeartbeat(write, input.runId);
    });

/**
 * The terminal statuses a stage row can carry, and the ONE non-terminal one.
 *
 * `running` is written by {@link writeIngestStageStart} and must be replaced by
 * one of the others on EVERY exit path. It was not, for a long time: the stage
 * wrapper settled the row on success and on a typed failure but had no
 * interruption arm, so the derive watchdog and the outer run deadline both
 * stranded rows at `running` with no `ended_at` and no reason. 38 such rows
 * accumulated, 3 of them inside a run that reported `ok` (#840).
 *
 * The four non-`ok` statuses are deliberately distinct, because they are
 * distinct operator questions:
 *  - `error`       -> the stage's own work failed; read `error_text`
 *  - `timeout`     -> the derive watchdog capped it; the cap is the thing to raise
 *  - `skipped`     -> never attempted, no budget left before the run deadline
 *  - `interrupted` -> something outside the stage ended the run (deadline, SIGINT)
 * Collapsing these into `error` would tell an operator to debug a stage that
 * worked fine and simply ran out of clock.
 */
export type IngestStageTerminalStatus = "ok" | "error" | "timeout" | "skipped" | "interrupted";

/**
 * A settled stage outcome. `ok` carries counts; every non-`ok` status REQUIRES
 * `errorText`, enforced by the union rather than by a convention someone has to
 * remember - a terminal row with no reason is the defect this type exists to
 * prevent.
 */
export type IngestStageOutcome =
    | { readonly status: "ok"; readonly counts?: Record<string, number> }
    | {
        readonly status: Exclude<IngestStageTerminalStatus, "ok">;
        readonly errorText: string;
        readonly counts?: Record<string, number>;
    };

/**
 * Settle a stage row and bump the run heartbeat.
 *
 * `self_ms` is the stage's OWN database time, and it is not a nicety: with the
 * pipeline running 4 stages at once, `ended_at - started_at` is mostly other
 * stages' work, because calls on the shared write connection are serialized.
 * Measured on a real store, `claude-config` read
 * 0.4s serially against 380.2s concurrently (#841, #865). `null` means the
 * caller had no accumulator - a runner-side settle for a stage that never ran.
 */
export const writeIngestStageFinish = (
    write: CacheWriteService,
    input: {
        readonly runId: string;
        readonly source: string;
        readonly stage: string;
        readonly selfMs?: number | null | undefined;
    } & IngestStageOutcome,
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        yield* write.exec(
            // COALESCE: a runner-side overwrite (`timeout`/`skipped`, #840/#837)
            // carries no selfMs, and it must not null out the value the stage's
            // own finalizer just recorded - self_ms IS the evidence for why a
            // self-time budget fired. Nothing legitimately resets self_ms to
            // null once written.
            "UPDATE ingest_stage SET status = ?, ended_at = CURRENT_TIMESTAMP, counts = ?, error_text = ?, self_ms = COALESCE(?, self_ms) WHERE id = ?",
            [
                input.status,
                jsonParam(input.counts ?? {}),
                input.status === "ok" ? null : input.errorText,
                input.selfMs === undefined || input.selfMs === null
                    ? null
                    : Math.round(input.selfMs),
                ingestStageId(input.runId, input.source, input.stage),
            ],
        );
        yield* writeIngestRunHeartbeat(write, input.runId);
    });

/**
 * Reconcile stage rows that a previous run left at `running`.
 *
 * A finalizer cannot run if the process was hard-killed (SIGKILL, power loss),
 * so "settle on every exit path" can never be complete on its own - the next
 * run has to clean up after the one that could not. Scoped to rows whose PARENT
 * RUN is already terminal, so a genuinely concurrent run's live stages are never
 * touched, and excludes the caller's own run id for the same reason.
 *
 * Returns the number of rows reconciled. Idempotent: a second call finds none.
 */
export const reconcileStrandedIngestStages = (
    write: CacheWriteService,
    currentRunId: string,
): Effect.Effect<number, CacheReadError> =>
    write.raw(
        `UPDATE ingest_stage
         SET status = 'interrupted',
             ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
             error_text = COALESCE(error_text, 'interrupted - the run ended without settling this stage; reconciled by a later run')
         WHERE status = 'running' AND run <> ?
           AND run IN (SELECT id FROM ingest_run WHERE status <> 'running')`,
        [currentRunId],
    ).pipe(Effect.map((result) => result.rowsChanged));

/**
 * Append one ledger event AND fan it out to in-process subscribers.
 *
 * Both halves, always, in this order - the row is the durable record the Live
 * tab rehydrates from on reconnect, and the subscriber fan-out is what an
 * already-attached client sees now. A call site that did one without the other
 * produced a stream that replayed differently from how it ran.
 */
export const writeIngestEvent = (
    write: CacheWriteService,
    input: {
        readonly runId: string;
        readonly source: string;
        readonly stage: string;
        readonly level: IngestEventLevel;
        readonly message: string;
        readonly counts?: Record<string, number>;
    },
): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        const event = makeIngestEvent({ ...input, counts: input.counts ?? {} });
        yield* write.put(
            "ingest_event",
            cacheRow({
                id: event.id,
                run: event.runId,
                source: event.source,
                stage: event.stage,
                level: event.level,
                message: event.message,
                counts: jsonParam(event.counts),
                raw: jsonParam(event),
                // `ts` is a TIMESTAMP column; the seam binds a Date directly.
                // Passing `event.ts` (an ISO STRING) is the shape that writes a
                // row nothing can decode while ingest still exits 0.
                ts: new Date(event.ts),
            }),
        );
        publishIngestEvent(event);
    });

export type IngestEventSubscriber = (event: IngestEvent) => void;

const subscribers = new Set<IngestEventSubscriber>();

export function addIngestEventSubscriber(subscriber: IngestEventSubscriber): void {
    subscribers.add(subscriber);
}

export function removeIngestEventSubscriber(subscriber: IngestEventSubscriber): void {
    subscribers.delete(subscriber);
}

export function publishIngestEvent(event: IngestEvent): void {
    for (const subscriber of subscribers) {
        subscriber(event);
    }
}
