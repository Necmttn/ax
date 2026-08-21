/**
 * The clone-based snapshot publish fast path (#908): primitives for cloning
 * the live DuckDB file via APFS `clonefile` (copy-on-write) instead of the
 * logical `COPY FROM DATABASE`, plus the pure/effect guard helpers that
 * `publishSnapshot` (`client.ts`) runs the clone attempt through before it
 * trusts the result.
 *
 * RULING R6: runtime modules under `packages/lib/src/` may not import
 * `node:fs`/`node:path` (`check:no-node-fs`) - Effect's `FileSystem` service
 * is the replacement. This file is the ONE deliberate exception, registered
 * in `scripts/check-no-node-fs.ts`'s `EXCLUDED_FILES`: `copyFileSync`'s
 * `COPYFILE_FICLONE_FORCE` flag has no equivalent on `FileSystem` (it exposes
 * no clone flag at all), and FORCE (not the softer `COPYFILE_FICLONE`, which
 * silently falls back to a byte copy on failure) is load-bearing - a silent
 * byte-copy substitution would defeat the entire point of the fast path
 * without anyone noticing. Every use of the node import is wrapped in
 * `Effect.try` and never escapes this module as an untyped throw.
 */
import { copyFileSync, constants } from "node:fs";
import { Effect, FileSystem, Option } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { skipNotFound } from "../shared/fs-error.ts";

/** Outcome of one `cloneFile` attempt. Never throws/fails - a failed clone
 *  (non-APFS filesystem, cross-device `EXDEV`, unsupported `ENOTSUP`, or any
 *  other native error) is reported as data so the caller can fall back to the
 *  logical copy path. */
export interface CloneOutcome {
    readonly cloneable: boolean;
    readonly reason?: string;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Attempt an APFS `clonefile` (copy-on-write) of `src` to `dst` via
 * `COPYFILE_FICLONE_FORCE`. FORCE, not the plain `COPYFILE_FICLONE`: the
 * force flag makes the call FAIL when a true clone isn't possible rather
 * than silently degrading to a byte-for-byte copy, so a non-clone result is
 * always visible to the caller as `{ cloneable: false }` and never mistaken
 * for the fast path having run.
 *
 * `dst` must not already exist (or must be safely overwritable) - this
 * function does not check; callers stage into a fresh temp path.
 */
export const cloneFile = (src: string, dst: string): Effect.Effect<CloneOutcome> =>
    Effect.try({
        try: () => {
            copyFileSync(src, dst, constants.COPYFILE_FICLONE_FORCE);
        },
        catch: (err) => errorMessage(err),
    }).pipe(
        Effect.as({ cloneable: true } as const),
        Effect.catch((reason) => Effect.succeed({ cloneable: false, reason } as const)),
    );

/** The two stat fields the torn-copy tripwire compares. */
export interface FileStatSnapshot {
    readonly size: number;
    readonly mtimeMs: number;
}

/**
 * Torn-copy tripwire, pure half: `true` iff two stat snapshots of the SAME
 * path, taken immediately before and immediately after the clone, describe
 * the same file - i.e. nothing else wrote to it while the clone ran. Split
 * out from the effectful stat call so this comparison is unit-testable
 * without touching a filesystem.
 */
export const statsEqual = (a: FileStatSnapshot, b: FileStatSnapshot): boolean =>
    a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Torn-copy tripwire, effectful half: take a `{ size, mtimeMs }` snapshot of
 *  `path`. Fails (typed `PlatformError`) exactly when `fs.stat` fails -
 *  callers decide what a stat failure means for their fallback logic. */
export const statSnapshot = (
    fs: FileSystem.FileSystem,
    path: string,
): Effect.Effect<FileStatSnapshot, PlatformError> =>
    fs.stat(path).pipe(
        Effect.map((info) => ({
            size: Number(info.size),
            mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
        })),
    );

/**
 * Post-checkpoint tripwire: `true` iff `<livePath>.wal` is absent or exactly
 * 0 bytes. A non-empty WAL after `CHECKPOINT` means the checkpoint did not
 * fully flush committed data out of the WAL and into the base file - cloning
 * the base file alone would silently miss it, so this must hold before the
 * clone is trusted. Never fails: a stat error (including the WAL vanishing
 * between the exists-check and the stat, a benign race with DuckDB's own WAL
 * lifecycle) is treated as "absent" -> quiescent. Every other stat error is
 * unsafe, so it returns false and makes publish use the logical copy path.
 */
export const walIsQuiescent = (fs: FileSystem.FileSystem, livePath: string): Effect.Effect<boolean> =>
    fs.stat(`${livePath}.wal`).pipe(
        Effect.map((info) => Number(info.size) === 0),
        skipNotFound(true),
        Effect.orElseSucceed(() => false),
    );
