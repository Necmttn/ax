/**
 * The one atomic-publish primitive: build a file at a temp path, then `rename`
 * it into place.
 *
 * Three modules had grown their own copy of this dance - `atomic-write.ts` (the
 * config front-door mutators), `duckdb/dylib.ts` (extracting the embedded
 * libduckdb), and `duckdb/client.ts` (publishing the database snapshot) - and
 * the copies had already drifted: only one of them had learned that a pid-only
 * temp suffix is NOT unique within a process, so two fibers publishing the same
 * target shared a staging path and could rename or delete the file the other was
 * still writing.
 *
 * WHY RENAME, precisely. The temp path is always a SIBLING of the target (same
 * directory => same filesystem), which is what makes `rename` atomic rather than
 * `EXDEV`-failing or byte-copying. A reader that already has the target open
 * keeps reading the OLD inode, uninterrupted, for as long as it holds that
 * handle - that is the entire point for the snapshot publisher, and it is why a
 * "write directly over the target" shortcut is not an acceptable simplification
 * here.
 *
 * WHAT IT GUARANTEES:
 *   - The target is only ever replaced by a COMPLETE file. Nothing writes to the
 *     target path itself; a failure anywhere before the rename leaves whatever
 *     was there untouched.
 *   - No `.tmp` litter: the temp path is removed on EVERY exit path via
 *     `Effect.ensuring` (after a successful rename it is already gone, so the
 *     removal is a no-op).
 *   - The temp name carries both the pid AND a uuid, so it is unique across
 *     processes and across fibers of one process.
 *
 * WHAT IT DOES NOT: arbitrate two publishers racing the same target. Both will
 * land a complete file and the last rename wins. Callers that need one winner
 * need a lock (see `@ax/lib/ingest-lock`), not this.
 *
 * RULING R6: this is a runtime module under `packages/lib/src/`, so `node:fs` /
 * `node:path` are banned. Filesystem access goes through `FileSystem.FileSystem`
 * and path joins through `posixPath`.
 */
import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { posixPath } from "./shared/path.ts";

/** Which of this primitive's OWN filesystem steps failed. The caller's `stage` /
 *  `beforeRename` failures are its own typed error and never reach `onFsError`. */
export type StagedRenameStep =
    /** creating the target's parent directory */
    | "makeDirectory"
    /** clearing a pre-existing file at the temp path */
    | "removeStale"
    /** the atomic swap itself */
    | "rename";

export interface StagedRenameOptions<E, R> {
    /** Produce the complete file at `tmpPath`. Runs with the parent directory
     *  guaranteed to exist and nothing else at that path. */
    readonly stage: (tmpPath: string) => Effect.Effect<void, E, R>;
    /** Runs after `stage` succeeded and BEFORE the swap, while the target is
     *  still the old file - the window for a backup copy. A failure here aborts
     *  the publish with the target untouched. */
    readonly beforeRename?: (tmpPath: string) => Effect.Effect<void, E, R>;
    /** Runs after the swap landed, on the published file (e.g. chmod). It cannot
     *  fail: the file is already published, so there is nothing left to abort. */
    readonly afterRename?: Effect.Effect<void, never, R>;
    /** Map a fault in one of this primitive's own steps into the caller's error
     *  type, so the error channel is exactly `E`. Pass `(_, err) => err` to let
     *  the `PlatformError` through unchanged. */
    readonly onFsError: (step: StagedRenameStep, err: PlatformError) => E;
}

export const stageAndRename = <E, R = never>(
    target: string,
    options: StagedRenameOptions<E, R>,
): Effect.Effect<void, E, R | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const at = (step: StagedRenameStep) => Effect.mapError((err: PlatformError) => options.onFsError(step, err));

        // pid AND uuid: the pid alone is not unique WITHIN a process, and two
        // fibers publishing the same target used to collide on it.
        const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;

        const publish = Effect.gen(function* () {
            yield* fs.makeDirectory(posixPath.dirname(target), { recursive: true }).pipe(at("makeDirectory"));
            // Cannot collide in practice (the name carries a uuid), but staging
            // ONTO an existing file would be a silent correctness bug for the
            // callers that ATTACH the temp path rather than truncate it, so the
            // cheap syscall stays.
            yield* fs.remove(tmp, { force: true, recursive: true }).pipe(at("removeStale"));

            yield* options.stage(tmp);
            if (options.beforeRename !== undefined) yield* options.beforeRename(tmp);

            yield* fs.rename(tmp, target).pipe(at("rename"));
            if (options.afterRename !== undefined) yield* options.afterRename;
        });

        // On success the temp path is already gone (renamed away); on any
        // failure - typed, defect, or interruption - this is what stops a
        // half-written file from being left behind. It must not fail, and must
        // never mask the primary error.
        //
        // It LOGS rather than ignoring (carried over from the snapshot
        // publisher's cross-review P3-6): `force: true` already tolerates
        // "already gone", so anything reaching this handler is a real failure,
        // and the litter can be a complete copy of the database. Swallowing it
        // erased the event entirely; failing here would mask the primary error,
        // which is worse.
        const removeTmp = fs.remove(tmp, { force: true, recursive: true }).pipe(
            Effect.catch((err) =>
                Effect.logWarning(`ax: could not remove the temporary file staged for ${target} at ${tmp}: ${err.message}`),
            ),
        );

        yield* publish.pipe(Effect.ensuring(removeTmp));
    });
