/**
 * The shared per-file execution loop for the three JSONL transcript providers
 * (claude / codex / pi). Each provider discovers its own candidates (claude
 * keeps its flat walk; codex/pi use `walkJsonlFilesStrict`/`Lenient`) and
 * supplies a `processFile` that parses + writes ONE file. This work-unit owns
 * the mechanics every provider previously hand-rolled (only claude did all of
 * them): the skip-unchanged watermark read/skip/commit, per-file failure
 * isolation, the deadline time-box, and the file/active-file counters.
 *
 * Load-bearing ordering preserved from the claude reference loop:
 *  - `unchanged()` skip happens BEFORE the failure-isolation wrapper, so a
 *    skipped file is free (no parse, no write);
 *  - `commit()` runs INSIDE the isolate, only AFTER `processFile` succeeds, so a
 *    mid-file failure never advances the watermark and the file retries next run;
 *  - a `processFile` returning `null` (file vanished between discovery and read)
 *    neither counts nor commits.
 *
 * The work-unit owns ONLY loop mechanics. Per-provider domain counters
 * (turns / tool calls / edits / ...) and the shape of progress payloads stay in
 * the provider: it mutates its own counters inside `processFile` and reads the
 * loop counters (file index, files-done, active-files) back through the live
 * `loop` accessor passed to `processFile`, so a provider that emits progress at
 * several points mid-file (codex flushes) reads up-to-date numbers each time.
 */

import { Effect } from "effect";
import type { DbError } from "@ax/lib/errors";
import { fileWatermark, hashFileSha256, WATERMARK_TABLE } from "@ax/lib/duckdb/watermark";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import type { TableSpool } from "@ax/lib/duckdb/spool";
import type { DuckDbParam } from "@ax/lib/duckdb/types";
import { type FileFailureCollector, type FileFailureSnapshot, makeFileFailureCollector } from "./file-isolation.ts";
import type { JsonlFileCandidate } from "./walk-jsonl.ts";

/** One cheap heartbeat per this many successfully committed provider files. */
export const INGEST_RUN_HEARTBEAT_EVERY_FILES = 25;

/**
 * The tables a JSONL provider stage routes through the NDJSON spool (#886).
 *
 * Membership is NOT a volume judgment alone - it is the read-back survey's
 * verdict (issue #886): a table may spool ONLY if no provider stage reads it
 * back in the same run, because a spooled row is invisible to SQL until flush.
 * The survey pinned three exclusions and one ordering rule:
 *
 *  - `session` stays DIRECT: git ingest reads `session.checkout` it wrote
 *    lines earlier, and the subagents stage backfills rows it wrote same-run.
 *  - `skill` stays DIRECT: `relateToolCallSkill` probes `skillExists` before
 *    minting a ghost row, and the catalog reads in the provider stages must
 *    see the `skills`/`commands` stages' rows.
 *  - `plan_item` stays DIRECT: its writer DELETEs by (plan, external_id/seq)
 *    immediately before inserting - keys OTHER than id, so the pass-through
 *    DELETE could race rows already sitting in a buffer.
 *  - `agent_event`/`agent_event_child` spool ONLY because their per-session
 *    DELETE fires once per session per run, BEFORE the first row for that
 *    session is appended (see spool.ts "DELETE ORDERING").
 *
 * Cross-STAGE reads (claude-sidecars reads `tool_call`; derive stages read
 * everything) are safe because every buffered row flushes before the stage
 * returns.
 */
export const INGEST_SPOOL_TABLES: ReadonlyArray<string> = [
    "turn",
    "tool_call",
    "turn_token_usage",
    "session_token_usage",
    "agent_provider",
    "agent_session",
    "agent_event",
    "agent_event_child",
    "harness_hook_event",
    "hook_command_invocation",
    "invoked",
    "concerns",
    "tool",
    "file",
    "compaction",
];

/** Flush once this many rows sit in the spool. Bounds memory (a `turn` row
 *  carries full text, so 25k rows is on the order of tens of MB) while keeping
 *  each `read_ndjson` load big enough to amortize. */
export const SPOOL_FLUSH_PENDING_ROWS = 25_000;

/** Pure throttle decision, exported so the cadence cannot regress silently. */
export const shouldHeartbeatIngestRun = (completedFiles: number): boolean =>
    completedFiles > 0 && completedFiles % INGEST_RUN_HEARTBEAT_EVERY_FILES === 0;

/** Live loop state readable by `processFile` at any point: the one counter a
 *  provider can't compute itself (the work-unit owns active-file tracking).
 *  Getter reflects current state, so mid-file progress emits stay accurate. */
export interface JsonlWorkUnitLoop {
    /** Files currently in flight (the current file IS counted here). */
    readonly activeFiles: number;
}

export interface RunJsonlProviderFilesOptions<E, R, C extends JsonlFileCandidate> {
    readonly candidates: readonly C[];
    /** Watermark `source_kind` column, e.g. "codex_session". */
    readonly sourceKind: string;
    /** Env var forcing a full re-derive when "1", e.g. "AX_REDERIVE_CODEX". */
    readonly forceEnv: string;
    /** Failure-collector provider label for log lines, e.g. "codex". */
    readonly source: string;
    /** Parent ingest run to heartbeat. Omitted by standalone provider calls. */
    readonly runId?: string;
    /** Live-progress publish hook for the skipped-file list (see file-isolation). */
    readonly onFileFailures?: (snapshot: FileFailureSnapshot) => Effect.Effect<void>;
    /** Dry-run calibration deadline: once passed, start no new files. */
    readonly deadlineMs?: number;
    /** Per-file concurrency. Defaults to 1 (sequential) to match the providers. */
    readonly concurrency?: number | "unbounded";
    /**
     * Opt into the SHA-256 content tier (#900). When on: the fast (mtime,size)
     * skip is unchanged; a file whose stats MOVED is hashed before parsing,
     * and an identical hash (mtime churn, resync, touch) refreshes the mark
     * and SKIPS the parse - the third outcome beside processed/skipped.
     * Genuinely-changed files carry their fresh hash into the committed mark.
     * The transcript providers set it; the append-only otel spool leaves it
     * off (its files never revert, so hashing them buys nothing).
     */
    readonly contentHash?: boolean;
    /**
     * The stage's NDJSON spool, when its writes route through `withTableSpool`.
     * The work-unit then owns the flush cadence AND defers every watermark to
     * the flush that lands its rows: marks are snapshotted BEFORE the spool
     * drains, then written only after the drained rows are in the table, so a
     * crash between the two re-processes those files instead of skipping them.
     */
    readonly spool?: TableSpool;
    /**
     * Parse + write ONE file. Mutate provider-owned counters here, and read the
     * live `loop` accessor for any progress emits. Return `true` on success
     * (the work-unit then commits the watermark), or `false` if the file
     * vanished / had nothing to write and must NOT advance the watermark.
     */
    readonly processFile: (
        candidate: C,
        index: number,
        loop: JsonlWorkUnitLoop,
    ) => Effect.Effect<boolean, E, R>;
}

export interface JsonlWorkUnitResult {
    /** Files committed this run (processFile returned true). */
    readonly files: number;
    /** Candidates skipped because their (mtime,size) matched the watermark. */
    readonly skippedUnchanged: number;
    /** Candidates whose stats moved but whose CONTENT hash matched the stored
     *  mark (#900): mark refreshed, parse skipped. 0 with `contentHash` off. */
    readonly refreshedUnchanged: number;
    /** The failure collector (count() / failures) for the provider's stats. */
    readonly failures: FileFailureCollector;
}

export const runJsonlProviderFiles = <E = never, R = never, C extends JsonlFileCandidate = JsonlFileCandidate>(
    write: CacheWriteService,
    opts: RunJsonlProviderFilesOptions<E, R, C>,
): Effect.Effect<JsonlWorkUnitResult, DbError | CacheWriteError, R> =>
    Effect.gen(function* () {
        const wm = yield* fileWatermark(write, {
            sourceKind: opts.sourceKind,
            forceEnv: opts.forceEnv,
            ...(opts.contentHash === true ? { contentHash: true } : {}),
        });
        const failures = makeFileFailureCollector({
            source: opts.source,
            ...(opts.onFileFailures ? { onFailure: opts.onFileFailures } : {}),
        });

        let files = 0;
        let activeFiles = 0;
        let skippedUnchanged = 0;
        let refreshedUnchanged = 0;
        const loop: JsonlWorkUnitLoop = {
            get activeFiles() {
                return activeFiles;
            },
        };

        // Spool mode: watermarks are DEFERRED - collected here and written only
        // after the flush that lands their files' rows. Snapshot order inside
        // `flushCycle` is what keeps the invariant: marks are spliced FIRST,
        // then the spool drains. A mark enqueued before the splice covers a
        // file whose appends all happened before it completed, so every row it
        // covers is in the drained buffers; rows appended by files still in
        // flight stay buffered, and their marks are not in this snapshot.
        const pendingMarks: Array<Record<string, DuckDbParam>> = [];
        let flushing = false;
        const flushCycle = (spool: TableSpool): Effect.Effect<void, CacheWriteError> =>
            Effect.gen(function* () {
                // Under file-concurrency two fibers can cross the threshold
                // together; the loser skips - the next threshold crossing or
                // the final flush picks its rows up.
                if (flushing) return;
                flushing = true;
                yield* Effect.gen(function* () {
                    const marks = pendingMarks.splice(0);
                    yield* spool.flush(write);
                    if (marks.length > 0) yield* write.putMany(WATERMARK_TABLE, marks);
                }).pipe(
                    Effect.ensuring(
                        Effect.sync(() => {
                            flushing = false;
                        }),
                    ),
                );
            });

        yield* Effect.forEach(
            opts.candidates,
            (candidate, index) =>
                Effect.gen(function* () {
                    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) return;
                    // Skip BEFORE isolation: an unchanged file is output-equivalent
                    // to a prior run, so it costs nothing.
                    if (wm.unchanged(candidate.path, candidate.mtimeMs, candidate.sizeBytes)) {
                        skippedUnchanged += 1;
                        return;
                    }
                    // Durable tier (#900): stats moved, so hash the bytes
                    // BEFORE parsing - the hash then describes bytes no newer
                    // than what the parse reads, so a mid-parse append can
                    // only cause one redundant reparse, never a skipped one.
                    // Identical content (mtime churn, resync, touch) refreshes
                    // the mark and skips the parse: the rows are already in
                    // the store from the run that stamped this sha.
                    let contentSha: string | null = null;
                    if (opts.contentHash === true) {
                        contentSha = yield* hashFileSha256(candidate.path);
                        const stored = wm.storedSha(candidate.path);
                        const known =
                            contentSha !== null &&
                            (stored === contentSha ||
                                // Same bytes under a NEW path (#902): a
                                // `segment import` sentinel (__imported__/...)
                                // attesting the content was loaded already.
                                // Since #955 only imported marks feed this set -
                                // an ordinary moved/resynced file matches by its
                                // own stored (path, sha) mark instead.
                                (stored === null && wm.knownContentSha(contentSha)));
                        if (known) {
                            refreshedUnchanged += 1;
                            // Direct commit even in spool mode: a refresh has
                            // no spooled rows to wait for.
                            yield* wm.commit(candidate.path, candidate.mtimeMs, candidate.sizeBytes, contentSha);
                            return;
                        }
                    }
                    activeFiles += 1;
                    yield* failures.isolate(
                        candidate.path,
                        Effect.gen(function* () {
                            const committed = yield* opts.processFile(candidate, index, loop);
                            // false ⇒ vanished/empty: never count, never commit
                            // (so it isn't marked done and retries next run).
                            if (!committed) return;
                            files += 1;
                            const completedFiles = files;
                            // Commit ONLY after writes succeed. With a spool,
                            // "succeed" includes the flush, so the mark is
                            // deferred to the flush cycle instead.
                            if (opts.spool !== undefined) {
                                pendingMarks.push(wm.row(candidate.path, candidate.mtimeMs, candidate.sizeBytes, contentSha));
                            } else {
                                yield* wm.commit(candidate.path, candidate.mtimeMs, candidate.sizeBytes, contentSha);
                            }
                            if (opts.runId !== undefined && shouldHeartbeatIngestRun(completedFiles)) {
                                // Courtesy signal only: a transient heartbeat
                                // failure must never fail or roll back ingest.
                                yield* write.exec(
                                    "UPDATE ingest_run SET last_progress_at = CURRENT_TIMESTAMP WHERE id = ?",
                                    [opts.runId],
                                ).pipe(Effect.ignore);
                            }
                        }),
                    );
                    activeFiles -= 1;
                    // Cadence check OUTSIDE the isolate: a flush failure means
                    // the write path itself is broken, and that fails the
                    // stage instead of masquerading as one bad file.
                    if (opts.spool !== undefined && opts.spool.pendingRows() >= SPOOL_FLUSH_PENDING_ROWS) {
                        yield* flushCycle(opts.spool);
                    }
                }),
            { concurrency: opts.concurrency ?? 1, discard: true },
        );

        // Final flush: every buffered row and every deferred mark lands before
        // the loop reports. All fibers are done, so `flushing` cannot be held.
        if (opts.spool !== undefined) {
            yield* flushCycle(opts.spool);
            // Spooled values bypass the seam's bound-param NUL scrub, so its
            // end-of-run warning cannot see them; surface the spool's own count
            // here with the same rationale (silent sanitising is the failure
            // class the seam refuses).
            const totals = opts.spool.totals();
            if (totals.illFormedValues > 0) {
                yield* Effect.logWarning(
                    `ax cache: spool repaired ${totals.illFormedValues} text value(s) with an unpaired UTF-16 surrogate for ${opts.source} - DuckDB's read_ndjson rejects lone surrogates, so each was replaced with U+FFFD (#906).`,
                );
            }
            if (totals.nulValues > 0) {
                yield* Effect.logWarning(
                    `ax cache: spool stripped NUL bytes (U+0000) from ${totals.nulValues} text value(s) for ${opts.source} - a DuckDB VARCHAR cannot carry U+0000; the rest of each value was stored intact.`,
                );
            }
        }

        yield* failures.report;
        return { files, skippedUnchanged, refreshedUnchanged, failures };
    });
