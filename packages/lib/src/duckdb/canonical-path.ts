/**
 * One canonical spelling for a filesystem path, so two names for the SAME
 * file compare equal.
 *
 * Both consumers in this module were bitten by the same class of bug (found
 * in cross-review): `lock.ts` keyed its process-local "do we hold this lock"
 * state by the caller-supplied STRING, so `ingest.lock`, `/abs/ingest.lock`
 * and a symlinked alias of the directory looked like three different locks
 * and the second name stole the first one's live lock (P1-5); `client.ts`
 * compared `options.from.path` to `livePath` not at all, and would have been
 * fooled by the same aliasing had it compared them naively (P1-6/P2-4).
 *
 * The file itself usually does NOT exist yet (a lock about to be created, a
 * snapshot about to be published), so `realPath` is applied to the PARENT
 * DIRECTORY and the basename is appended. That resolves `.`/`..`, a relative
 * spelling, and every symlink ABOVE the file, which is the whole aliasing
 * surface that matters here. A symlink AT the leaf is deliberately not
 * followed: for a lock file that would resolve to the target the writer never
 * created, and for a snapshot the publish rename replaces the link itself.
 *
 * Canonicalization NEVER fails the caller. When the parent directory cannot
 * be resolved (it does not exist yet, or is unreadable) the input is returned
 * unchanged - the comparison then degrades to a plain string compare, which
 * is exactly the behavior these call sites had before, so a probe failure can
 * never turn a working publish or acquire into an error.
 *
 * RULING R6: runtime module under `packages/lib/src/`, so `node:fs`/
 * `node:path` are banned - `FileSystem.FileSystem` and `posixPath` only.
 */
import { Effect, type FileSystem } from "effect";
import { orAbsent } from "../shared/fs-error.ts";
import { posixPath } from "../shared/path.ts";

export const canonicalPath = (
    fs: FileSystem.FileSystem,
    path: string,
): Effect.Effect<string> =>
    Effect.suspend(() => {
        const dir = posixPath.dirname(path);
        const base = posixPath.basename(path);
        return fs.realPath(dir).pipe(
            Effect.map((real) => (base === "" || base === "." ? real : posixPath.join(real, base))),
            orAbsent(path),
        );
    });
