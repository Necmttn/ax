/**
 * Per-file failure isolation for transcript ingest loops.
 *
 * One corrupt transcript (or one statement the daemon rejects) must not abort
 * the whole provider stage: before this seam existed, the first failing file
 * froze every session ordered after it on every run (issue #251 was the
 * deterministic version of that). Each file's pipeline is wrapped in
 * {@link FileFailureCollector.isolate}: typed failures are recorded and
 * swallowed - the file's watermark never commits, so the next run retries it
 * - while the stage keeps going.
 *
 * The "file" is really a *unit of isolation*: for transcript providers
 * (claude/codex/pi) it is a session file, for SQLite-store providers
 * (opencode/cursor) it is one session within the store - re-extracted on the
 * next run either way, so skip-and-retry semantics carry over unchanged
 * (#261). `filePath` then holds a source locator (`<store path>#<session id>`)
 * rather than a literal path, and {@link FileFailureCollectorOptions.unit}
 * relabels the log lines.
 *
 * Two classes of failure still abort the stage, on purpose:
 *
 *  - connection loss (`DbError` with `operation: "connect"`): nothing after
 *    it can succeed, and per-file "isolation" would just spray one failure
 *    per remaining file;
 *  - a failure storm: `stormThreshold` consecutive failures with no success
 *    in between means the problem is systemic (wedged daemon, broken session,
 *    schema drift), not file-local. Counted approximately under concurrency -
 *    interleaved successes reset it - which is the behavior we want: any
 *    success proves the pipeline itself still works.
 *
 * Defects (Effect.die) are never isolated - they indicate bugs, not bad input.
 */

import { Effect } from "effect";
import { DbError } from "@ax/lib/errors";

export interface FileFailure {
    /** Source locator: a transcript file path, or `<store path>#<session id>`
     *  for SQLite-store providers where the unit of isolation is a session. */
    readonly filePath: string;
    /** Error tag (`DbError`, `SkillParseError`, ...) or constructor name. */
    readonly tag: string;
    readonly message: string;
}

/** Failures whose detail we keep; beyond this only the count grows. */
const DETAIL_CAP = 25;

/** Consecutive failures (no success in between) that abort the stage. */
const DEFAULT_STORM_THRESHOLD = 10;

const failureTag = (err: unknown): string => {
    if (typeof err === "object" && err !== null && "_tag" in err && typeof err._tag === "string") return err._tag;
    if (err instanceof Error) return err.name;
    return "Unknown";
};

const failureMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

const isConnectionError = (err: unknown): boolean =>
    err instanceof DbError && err.operation === "connect";

export interface FileFailureCollector {
    /** Recorded failure details, insertion order, capped at {@link DETAIL_CAP}. */
    readonly failures: ReadonlyArray<FileFailure>;
    /** Total failed-file count (not capped). */
    readonly count: () => number;
    /**
     * Run one file's pipeline with failures isolated: a typed failure is
     * recorded + logged and the effect succeeds with `undefined`, except for
     * connection errors and failure storms, which fail with `DbError` so the
     * stage aborts. Defects propagate untouched.
     */
    readonly isolate: <A, E, R>(
        filePath: string,
        eff: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A | undefined, DbError, R>;
    /** Log the aggregate (warn) when anything failed. Call once after the loop. */
    readonly report: Effect.Effect<void>;
}

export interface FileFailureCollectorOptions {
    /** Provider label for log lines, e.g. "claude" / "codex" / "pi". */
    readonly source: string;
    /** Isolation-unit noun for log lines: "file" (transcript providers) or
     *  "session" (SQLite-store providers). Defaults to "file". */
    readonly unit?: string;
    readonly stormThreshold?: number;
}

export const makeFileFailureCollector = (
    opts: FileFailureCollectorOptions,
): FileFailureCollector => {
    const stormThreshold = opts.stormThreshold ?? DEFAULT_STORM_THRESHOLD;
    const unit = opts.unit ?? "file";
    const failures: FileFailure[] = [];
    let total = 0;
    let consecutive = 0;

    const isolate = <A, E, R>(
        filePath: string,
        eff: Effect.Effect<A, E, R>,
    ): Effect.Effect<A | undefined, DbError, R> =>
        eff.pipe(
            Effect.tap(() => Effect.sync(() => { consecutive = 0; })),
            Effect.catch((err) =>
                Effect.gen(function* () {
                    if (isConnectionError(err)) return yield* err as DbError;
                    total += 1;
                    consecutive += 1;
                    if (failures.length < DETAIL_CAP) {
                        failures.push({ filePath, tag: failureTag(err), message: failureMessage(err) });
                    }
                    yield* Effect.logWarning(`${opts.source} ingest: ${unit} failed, skipping (will retry next run)`, {
                        filePath,
                        tag: failureTag(err),
                        message: failureMessage(err),
                    });
                    if (consecutive >= stormThreshold) {
                        return yield* new DbError({
                            operation: "query",
                            message:
                                `${opts.source} ingest aborted: ${consecutive} consecutive ${unit}s failed ` +
                                `(${total} total) - systemic failure, not bad input. Last: ${filePath}: ${failureMessage(err)}`,
                        });
                    }
                    return undefined;
                }),
            ),
        );

    return {
        failures,
        count: () => total,
        isolate,
        report: Effect.suspend(() => {
            if (total === 0) return Effect.void;
            return Effect.logWarning(`${opts.source} ingest: ${total} ${unit}(s) failed and were skipped; they retry next run`, {
                failures: failures.map((f) => `${f.filePath}: [${f.tag}] ${f.message}`),
                detailCapped: total > failures.length,
            });
        }),
    };
};
