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
import { copyFileSync, constants, statSync } from "node:fs";
import { Effect, FileSystem, Schema } from "effect";
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

/** The two stat fields the torn-copy tripwire compares. `mtimeNs` is the
 *  filesystem's raw nanosecond mtime (not `Date`'s whole-millisecond
 *  `getTime()`) - see {@link statSnapshot} for why the precision matters. */
export interface FileStatSnapshot {
    readonly size: number;
    readonly mtimeNs: bigint;
}

/**
 * Torn-copy tripwire, pure half: `true` iff two stat snapshots of the SAME
 * path, taken immediately before and immediately after the clone, describe
 * the same file - i.e. nothing else wrote to it while the clone ran. Split
 * out from the effectful stat call so this comparison is unit-testable
 * without touching a filesystem.
 */
export const statsEqual = (a: FileStatSnapshot, b: FileStatSnapshot): boolean =>
    a.size === b.size && a.mtimeNs === b.mtimeNs;

/** A native `fs.statSync` call failed. Never an untyped throw - see the
 *  module header on why `statSnapshot` reaches for `node:fs` at all. */
export class PreciseStatError extends Schema.TaggedErrorClass<PreciseStatError>(
    "PreciseStatError",
)("PreciseStatError", {
    path: Schema.String,
    message: Schema.String,
}) {}

/**
 * Torn-copy tripwire, effectful half: take a `{ size, mtimeNs }` snapshot of
 * `path` via `statSync(path, { bigint: true })`. Effect's `FileSystem.stat`
 * reports mtime as a `Date`, whose `getTime()` truncates to whole
 * milliseconds - a same-size, in-place page rewrite that lands within the
 * SAME millisecond as the pre-clone stat was therefore invisible to the
 * tripwire (#952). `statSync`'s `bigint` mode reports the filesystem's actual
 * nanosecond mtime, so two writes a fraction of a millisecond apart still
 * compare unequal. This is the module's one permitted `node:fs` call outside
 * `cloneFile` itself (see the header): the native call is wrapped in
 * `Effect.try` so a stat failure is a typed error, never an uncaught throw -
 * callers decide what a stat failure means for their fallback logic.
 */
export const statSnapshot = (path: string): Effect.Effect<FileStatSnapshot, PreciseStatError> =>
    Effect.try({
        try: (): FileStatSnapshot => {
            const info = statSync(path, { bigint: true });
            return { size: Number(info.size), mtimeNs: info.mtimeNs };
        },
        catch: (err) => new PreciseStatError({ path, message: errorMessage(err) }),
    });

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

/** `clearPartialClone` could not remove the temp path - see its docstring for
 *  why this is a typed failure rather than a swallowed warning. */
export class ClearPartialCloneError extends Schema.TaggedErrorClass<ClearPartialCloneError>(
    "ClearPartialCloneError",
)("ClearPartialCloneError", {
    path: Schema.String,
    message: Schema.String,
}) {}

/**
 * Remove a temp path a `cloneFile` attempt has already written to, before a
 * caller falls back to producing the SAME path a different way (a logical
 * copy that the fallback then `ATTACH`es). Meant to be called on EVERY
 * rejection reached once `cloneFile` has run - including a `{ cloneable:
 * false }` outcome itself, since `copyfile(3)` does not promise a failed
 * clone left `dst` untouched (ENOSPC mid-clone can leave a truncated file) -
 * so the fallback never lands on, or is mistaken for, a stale partial clone.
 *
 * UNLIKE a swallowed best-effort cleanup, a removal failure here is a typed
 * FAILURE, not a logged warning: the caller (`publishSnapshot` in
 * `client.ts`) treats it as fatal and aborts the whole publish attempt
 * rather than falling through to a fallback of unknown provenance at the
 * same path - the previous snapshot is left exactly as it was (#952).
 */
export const clearPartialClone = (
    fs: FileSystem.FileSystem,
    tmp: string,
): Effect.Effect<void, ClearPartialCloneError> =>
    fs.remove(tmp, { force: true, recursive: true }).pipe(
        Effect.mapError((err) => new ClearPartialCloneError({ path: tmp, message: err.message })),
    );
