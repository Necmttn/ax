import { Effect, FileSystem, Option, Path, PlatformError, Schema } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import type { DbError } from "@ax/lib/errors";
import { WATERMARK_TABLE, watermarkRow } from "@ax/lib/duckdb/watermark";
import { defaultOtlpSpoolDir } from "../otel/spool-server.ts";
import { SIGNALS } from "../otel/signals.ts";
import { OTLP_SIGNAL_PATHS } from "../otel/signal.ts";
import { OtelWriter, OtelWriterLive } from "../otel/writer.ts";
import { runJsonlProviderFiles } from "./jsonl-work-unit.ts";
import { walkJsonlFilesStrict, type JsonlFileCandidate } from "./walk-jsonl.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { skipPlatformStage } from "./platform-stage.ts";

/**
 * ---------------------------------------------------------------------------
 * Metric-point natural-key cutover (#1011)
 * ---------------------------------------------------------------------------
 * `otel_metric_point.id` used to hash only (harness, metric, session, model,
 * skill) + observed_at, omitting most OTLP data-point dimensions (`type`,
 * `query_source`, `agent.name`, an MCP server name, ...) - distinct points
 * collapsed onto one id (~600-740 collapsed rows per warm ingest, pure wasted
 * UPSERT work; no corruption, since dedup always kept the last write).
 * `metricPointKey`/`metricPointRowId` (apps/axctl/src/otel/rows.ts) now fold
 * in the full CANONICALIZED attrs JSON, which changes EVERY existing row's
 * id. A warm ingest normally skips spool files whose (mtime, size) match
 * their watermark, so without a cutover the stale collapsed rows would sit
 * next to correctly-keyed new ones forever.
 *
 * This cutover runs ONCE per key-version (gated by
 * METRIC_KEY_CUTOVER_VERSION, mirroring CONTENT_HASH_VERSION in
 * watermark.ts) and, before the ordinary spool replay that follows:
 *   1. deletes `telemetry_of` edges targeting otel_metric_point rows,
 *   2. deletes every otel_metric_point row,
 *   3. clears otel_spool file watermarks, so every RETAINED spool file
 *      re-ingests under the ordinary `ingestOtelSpool` call right after -
 *      that call is steps 4 (replay) and, on success, 5 (marker write).
 *
 * IDEMPOTENCY / CRASH WINDOW: the version marker is written ONLY after the
 * replay succeeds. A crash between the wipe and the marker leaves the
 * sentinel absent, so the NEXT run repeats the whole sequence: the deletes
 * are plain DELETEs (idempotent - a second run against already-empty tables
 * is a no-op) and the replay re-derives deterministic content-hash ids
 * (idempotent UPSERT), so re-running from scratch is always safe. The only
 * cost is redundant reprocessing of spool files a crashed run had already
 * caught up on - it can never leave a mix of old- and new-keyed rows behind,
 * because step 2 always wipes the table before any replay is trusted to
 * repopulate it. This all happens against the LIVE cache file inside one
 * ingest run; a reader of the PUBLISHED snapshot never observes the
 * mid-cutover empty state, since publish only happens at a successful run's
 * end.
 *
 * RETENTION ASYMMETRY (accepted, not fixed here): the spool retains 90 days
 * of raw payloads but metric retention prunes at 30 days. Replay restores
 * whatever raw input is still on disk, and ordinary retention prunes it back
 * down afterward - a metric older than 90 days at cutover time cannot be
 * recovered (it would already be gone under the old scheme too).
 */
/** Exported for test verification only - bump to re-arm the cutover on a
 *  future key-scheme change. */
export const METRIC_KEY_CUTOVER_VERSION = "attrs-key-v1";
export const METRIC_KEY_CUTOVER_SENTINEL_PATH = "__metric_key_cutover__/otel_spool";

const CutoverSentinelRow = Schema.Struct({ sha: Schema.NullOr(Schema.String) });

const metricKeyCutoverDone = (write: CacheWriteService): Effect.Effect<boolean, CacheWriteError> =>
    write.first(
        CutoverSentinelRow,
        `SELECT sha FROM ${WATERMARK_TABLE} WHERE path = ?`,
        [METRIC_KEY_CUTOVER_SENTINEL_PATH],
    ).pipe(
        Effect.map(Option.match({
            onNone: () => false,
            onSome: (row) => row.sha === METRIC_KEY_CUTOVER_VERSION,
        })),
    );

/** Steps 1-3: wipe stale metric-point rows/edges and clear otel_spool marks
 *  so the replay that follows re-derives every retained spool file under the
 *  new key. Each statement is independently idempotent - safe to re-run if a
 *  prior attempt crashed before the version marker was written. */
const runMetricKeyCutover = (write: CacheWriteService): Effect.Effect<void, CacheWriteError> =>
    Effect.gen(function* () {
        yield* write.exec("DELETE FROM telemetry_of WHERE out_table = ?", ["otel_metric_point"]);
        yield* write.exec("DELETE FROM otel_metric_point");
        yield* write.exec(`DELETE FROM ${WATERMARK_TABLE} WHERE source_kind = ?`, ["otel_spool"]);
    });

/** Step 5: write the version marker. Called ONLY after step 4 (the ordinary
 *  replay in `ingestOtelSpool`) has succeeded. */
const markMetricKeyCutoverDone = (write: CacheWriteService): Effect.Effect<void, CacheWriteError> =>
    write.put(
        WATERMARK_TABLE,
        watermarkRow("otel_spool", METRIC_KEY_CUTOVER_SENTINEL_PATH, { sha: METRIC_KEY_CUTOVER_VERSION }),
    );

interface SpoolEnvelope {
    readonly path: string;
    readonly body: string;
    /** Server receive time (spool-server stamps every record). Used as the
     *  observed_at FALLBACK for OTLP events that carry no event-time, so two
     *  timeless events do not collide on the unix-epoch row key. */
    readonly received_at: string | null;
}

const decodeEnvelope = (line: string): SpoolEnvelope | null => {
    try {
        const value: unknown = JSON.parse(line);
        if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        return typeof record.path === "string" && typeof record.body === "string"
            ? {
                path: record.path,
                body: record.body,
                received_at: typeof record.received_at === "string" ? record.received_at : null,
            }
            : null;
    } catch {
        return null;
    }
};

/**
 * OTLP events that carry no event-time normalize to `observed_at = new Date(0)`
 * (the unix epoch - see nanoToDate). The metric/log row keys embed observed_at,
 * so two such timeless events in one session would collide on the epoch key and
 * silently overwrite (stable-id bans time keys; missing times must not alias).
 * Stamp any epoch-dated row with the spool record's `received_at` instead, so
 * events received at different times get distinct identities/ordering.
 */
const EPOCH_MS = 0;
export const stampReceivedAt = <R extends { readonly observed_at: Date }>(
    rows: readonly R[],
    receivedAt: Date | null,
): readonly R[] => {
    if (receivedAt === null || Number.isNaN(receivedAt.getTime())) return rows;
    return rows.map((r) =>
        r.observed_at instanceof Date && r.observed_at.getTime() === EPOCH_MS
            ? { ...r, observed_at: receivedAt }
            : r,
    );
};

const parseBody = (body: string): unknown | undefined => {
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
};

export interface IngestOtelSpoolOptions {
    readonly spoolDir?: string;
    readonly runId?: string;
}

export interface OtelSpoolIngestResult {
    readonly files: number;
    readonly skippedUnchanged: number;
    readonly payloads: number;
    readonly rows: number;
    readonly malformed: number;
    readonly failedFiles: number;
}

/** Tail changed daily spool files and write decoded payloads with OtelWriter. */
export const ingestOtelSpool = (
    write: CacheWriteService,
    opts: IngestOtelSpoolOptions = {},
): Effect.Effect<
    OtelSpoolIngestResult,
    DbError | CacheWriteError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spoolDir = opts.spoolDir ?? defaultOtlpSpoolDir();
        const candidates = yield* walkJsonlFilesStrict(spoolDir, 0);
        let payloads = 0;
        let rows = 0;
        let malformed = 0;

        // Metric-point natural-key cutover (#1011, see the block comment
        // above): runs its destructive wipe BEFORE the watermark-driven
        // replay below reads marks, so the cleared otel_spool marks are what
        // the replay actually sees. The version marker is written only after
        // that replay succeeds (below), never here.
        const cutoverPending = !(yield* metricKeyCutoverDone(write));
        if (cutoverPending) yield* runMetricKeyCutover(write);

        const result = yield* runJsonlProviderFiles<
            CacheWriteError | PlatformError.PlatformError,
            OtelWriter,
            JsonlFileCandidate
        >(write, {
            candidates,
            sourceKind: "otel_spool",
            forceEnv: "AX_REDERIVE_OTEL_SPOOL",
            source: "otel-spool",
            ...(opts.runId === undefined ? {} : { runId: opts.runId }),
            processFile: (candidate) =>
                Effect.gen(function* () {
                    // Whole-file read (not a true tail): the daily spool file is
                    // re-read in full whenever it changes. The work-unit
                    // watermark (jsonl-work-unit.ts) skips UNCHANGED files, so a
                    // quiescent day is not re-read; only a file that grew is read
                    // whole. A real offset tail is a larger change, deferred
                    // past the wave-1 seam.
                    const text = yield* fs.readFileString(candidate.path);
                    const writer = yield* OtelWriter;
                    for (const line of text.split("\n")) {
                        if (line.trim().length === 0) continue;
                        const envelope = decodeEnvelope(line);
                        const signal = envelope ? OTLP_SIGNAL_PATHS[envelope.path] : undefined;
                        if (!envelope || !signal) {
                            malformed += 1;
                            continue;
                        }
                        const json = parseBody(envelope.body);
                        if (json === undefined) {
                            malformed += 1;
                            continue;
                        }
                        const spec = SIGNALS[signal];
                        const decoded = yield* spec.decode(json).pipe(
                            Effect.option,
                        );
                        if (decoded._tag === "None") {
                            malformed += 1;
                            continue;
                        }
                        const receivedAt = envelope.received_at === null
                            ? null
                            : new Date(envelope.received_at);
                        const normalized = stampReceivedAt(spec.normalize(decoded.value), receivedAt);
                        yield* spec.write(writer)(normalized);
                        payloads += 1;
                        rows += normalized.length;
                    }
                    return true;
                }),
        }).pipe(Effect.provide(OtelWriterLive(write)));

        // Step 5: mark the cutover done ONLY now that the replay above (step
        // 4) has completed without raising - a crash before this line leaves
        // the sentinel absent, so the next run repeats the wipe + replay.
        if (cutoverPending) yield* markMetricKeyCutoverDone(write);

        return {
            files: result.files,
            skippedUnchanged: result.skippedUnchanged,
            payloads,
            rows,
            malformed,
            failedFiles: result.failures.count(),
        };
    });

export const OtelSpoolKey = Schema.Literal("otel-spool");
export type OtelSpoolKey = typeof OtelSpoolKey.Type;

export class OtelSpoolStageStats extends BaseStageStats.extend<OtelSpoolStageStats>(
    "OtelSpoolStageStats",
)({
    filesIngested: Schema.Number,
    payloadsIngested: Schema.Number,
    rowsIngested: Schema.Number,
    malformedPayloads: Schema.Number,
    failedFiles: Schema.Number,
}) {}

export const otelSpoolStage: StageDef<
    OtelSpoolStageStats,
    FileSystem.FileSystem | Path.Path,
    DbError | CacheWriteError
> = {
    // "telemetry_of"/"derive" covers the #1011 metric-key cutover's one-time
    // DELETE of edges targeting otel_metric_point rows - legal without a
    // WRITE_MODE_EXCEPTIONS entry since telemetry_of is already a derived-layer
    // table (the correlation pass, ingest-run's NON_STAGE_WRITERS entry, is the
    // table's other writer).
    meta: StageMeta.make({ key: "otel-spool", deps: [], tags: ["ingest"], writes: [{ table: "otel_metric_point", mode: "parse" }, { table: "otel_span", mode: "parse" }, { table: "otel_log_event", mode: "parse" }, { table: "telemetry_of", mode: "derive" }, { table: "ingest_file_state", mode: "bookkeep" }, { table: "ingest_run", mode: "bookkeep" }] }),
    run: Effect.fn(function* (ctx: IngestContext, write: CacheWriteService) {
        const t0 = Date.now();
        const empty = (error: PlatformError.PlatformError) => OtelSpoolStageStats.make({
            durationMs: Date.now() - t0,
            summary: "otel-spool skipped (filesystem error; non-fatal)",
            filesIngested: 0, payloadsIngested: 0, rowsIngested: 0,
            malformedPayloads: 0, failedFiles: 1, failedOpenError: error.message,
        });
        return yield* ingestOtelSpool(write, {
            ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
        }).pipe(
            Effect.map((result) => OtelSpoolStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.payloads} OTLP payloads, ${result.rows} rows` +
                    (result.malformed > 0 ? `, ${result.malformed} malformed payloads skipped` : "") +
                    (result.failedFiles > 0 ? `, ${result.failedFiles} files failed` : ""),
                filesIngested: result.files,
                payloadsIngested: result.payloads,
                rowsIngested: result.rows,
                malformedPayloads: result.malformed,
                failedFiles: result.failedFiles,
            })),
            Effect.catchTag("PlatformError", (error) => skipPlatformStage("otel-spool", error, empty)),
        );
    }),
};
