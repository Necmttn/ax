import { Effect, FileSystem } from "effect";
import { orAbsent } from "./fs-error.ts";

export type EntryKind = "SymbolicLink" | "Directory" | "File" | "Other" | "Missing";

/**
 * Classify a path WITHOUT following symlinks (lstat-equivalent), matching node
 * `Dirent.isSymbolicLink()/isDirectory()/isFile()` semantics.
 *
 * Effect's `FileSystem` exposes no `lstat`, and `fs.stat` FOLLOWS symlinks, so
 * we detect a symlink first: `readLink` SUCCEEDS iff the path is a symbolic
 * link, and fails otherwise. When the path is not a link, `fs.stat` reports the
 * real type (a non-link real file/dir is unaffected by symlink-following).
 * This reproduces the old `Dirent`-based partition exactly: a symlinked
 * directory classifies as "SymbolicLink" (NOT "Directory"), so walkers that
 * recurse only on "Directory" never follow links out of the intended tree.
 */
export const classifyNoFollow = (
    path: string,
): Effect.Effect<EntryKind, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const isLink = yield* fs.readLink(path).pipe(Effect.as(true), orAbsent(false));
        if (isLink) return "SymbolicLink";
        return yield* fs.stat(path).pipe(
            Effect.map((info): EntryKind =>
                info.type === "Directory"
                    ? "Directory"
                    : info.type === "File"
                      ? "File"
                      : "Other",
            ),
            orAbsent("Missing" as EntryKind),
        );
    });
