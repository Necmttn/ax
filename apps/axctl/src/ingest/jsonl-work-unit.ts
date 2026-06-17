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
import type { SurrealClient } from "@ax/lib/db";
import { fileWatermark } from "@ax/lib/shared/watermark";
import { type FileFailureCollector, type FileFailureSnapshot, makeFileFailureCollector } from "./file-isolation.ts";
import type { JsonlFileCandidate } from "./walk-jsonl.ts";

/** Live loop counters, readable by `processFile` at any point (getters reflect
 *  current state, so mid-file progress emits stay accurate). */
export interface JsonlWorkUnitLoop {
    /** Total candidate count (includes those skipped as unchanged). */
    readonly total: number;
    /** Files fully processed so far this run (excludes skipped/vanished). The
     *  current file is NOT yet counted while its `processFile` runs. */
    readonly files: number;
    /** Files currently in flight (the current file IS counted here). */
    readonly activeFiles: number;
}

export interface RunJsonlProviderFilesOptions<A, E, R, C extends JsonlFileCandidate> {
    readonly candidates: readonly C[];
    /** Watermark `source_kind` column, e.g. "codex_session". */
    readonly sourceKind: string;
    /** Env var forcing a full re-derive when "1", e.g. "AX_REDERIVE_CODEX". */
    readonly forceEnv: string;
    /** Failure-collector provider label for log lines, e.g. "codex". */
    readonly source: string;
    /** Live-progress publish hook for the skipped-file list (see file-isolation). */
    readonly onFileFailures?: (snapshot: FileFailureSnapshot) => Effect.Effect<void>;
    /** Dry-run calibration deadline: once passed, start no new files. */
    readonly deadlineMs?: number;
    /** Per-file concurrency. Defaults to 1 (sequential) to match the providers. */
    readonly concurrency?: number | "unbounded";
    /**
     * Parse + write ONE file. Mutate provider-owned counters here, and read the
     * live `loop` accessor for any progress emits. Return the per-file result,
     * or `null` if the file vanished and must NOT advance the watermark / file
     * count.
     */
    readonly processFile: (
        candidate: C,
        index: number,
        loop: JsonlWorkUnitLoop,
    ) => Effect.Effect<A | null, E, R>;
}

export interface JsonlWorkUnitResult<A> {
    /** Files fully processed (non-skip, non-vanish). */
    readonly files: number;
    /** Candidates skipped because their (mtime,size) matched the watermark. */
    readonly skippedUnchanged: number;
    /** Non-null `processFile` results, in completion order. */
    readonly results: readonly A[];
    /** The failure collector (count() / failures) for the provider's stats. */
    readonly failures: FileFailureCollector;
}

export const runJsonlProviderFiles = <A, E = never, R = never, C extends JsonlFileCandidate = JsonlFileCandidate>(
    opts: RunJsonlProviderFilesOptions<A, E, R, C>,
): Effect.Effect<JsonlWorkUnitResult<A>, DbError, SurrealClient | R> =>
    Effect.gen(function* () {
        const wm = yield* fileWatermark({ sourceKind: opts.sourceKind, forceEnv: opts.forceEnv });
        const failures = makeFileFailureCollector({
            source: opts.source,
            ...(opts.onFileFailures ? { onFailure: opts.onFileFailures } : {}),
        });

        let files = 0;
        let activeFiles = 0;
        let skippedUnchanged = 0;
        const results: A[] = [];
        const total = opts.candidates.length;
        const loop: JsonlWorkUnitLoop = {
            total,
            get files() {
                return files;
            },
            get activeFiles() {
                return activeFiles;
            },
        };

        yield* Effect.forEach(
            opts.candidates.map((candidate, index) => ({ candidate, index })),
            ({ candidate, index }) =>
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
                            const result = yield* opts.processFile(candidate, index, loop);
                            // null ⇒ vanished between discovery and read: never count,
                            // never commit (so it isn't marked done).
                            if (result === null) return;
                            files += 1;
                            results.push(result);
                            // Commit ONLY after writes succeed.
                            yield* wm.commit(candidate.path, candidate.mtimeMs, candidate.sizeBytes);
                        }),
                    );
                    activeFiles -= 1;
                }),
            { concurrency: opts.concurrency ?? 1 },
        );

        yield* failures.report;
        return { files, skippedUnchanged, results, failures };
    });
