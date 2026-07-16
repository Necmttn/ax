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
import { SurrealClient } from "@ax/lib/db";
import { fileWatermark } from "@ax/lib/shared/watermark";
import { ingestRunHeartbeatStatement } from "../dashboard/telemetry.ts";
import { type FileFailureCollector, type FileFailureSnapshot, makeFileFailureCollector } from "./file-isolation.ts";
import type { JsonlFileCandidate } from "./walk-jsonl.ts";

/** One cheap heartbeat per this many successfully committed provider files. */
export const INGEST_RUN_HEARTBEAT_EVERY_FILES = 25;

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
    /** The failure collector (count() / failures) for the provider's stats. */
    readonly failures: FileFailureCollector;
}

export const runJsonlProviderFiles = <E = never, R = never, C extends JsonlFileCandidate = JsonlFileCandidate>(
    opts: RunJsonlProviderFilesOptions<E, R, C>,
): Effect.Effect<JsonlWorkUnitResult, DbError, SurrealClient | R> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const wm = yield* fileWatermark({ sourceKind: opts.sourceKind, forceEnv: opts.forceEnv });
        const failures = makeFileFailureCollector({
            source: opts.source,
            ...(opts.onFileFailures ? { onFailure: opts.onFileFailures } : {}),
        });

        let files = 0;
        let activeFiles = 0;
        let skippedUnchanged = 0;
        const loop: JsonlWorkUnitLoop = {
            get activeFiles() {
                return activeFiles;
            },
        };

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
                            // Commit ONLY after writes succeed.
                            yield* wm.commit(candidate.path, candidate.mtimeMs, candidate.sizeBytes);
                            if (opts.runId !== undefined && shouldHeartbeatIngestRun(completedFiles)) {
                                // Courtesy signal only: a transient heartbeat
                                // failure must never fail or roll back ingest.
                                yield* db.query(ingestRunHeartbeatStatement(opts.runId)).pipe(Effect.ignore);
                            }
                        }),
                    );
                    activeFiles -= 1;
                }),
            { concurrency: opts.concurrency ?? 1, discard: true },
        );

        yield* failures.report;
        return { files, skippedUnchanged, failures };
    });
