import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { orAbsent, skipNotFound } from "@ax/lib/shared/fs-error";
import { Effect, FileSystem, Option, Path, PlatformError } from "effect";

export interface JsonlFileCandidate {
    readonly path: string;
    readonly sizeBytes: number;
}

interface WalkEntryFile {
    readonly kind: "file";
    readonly mtimeMs: number;
    readonly sizeBytes: number;
}

interface WalkEntryDirectory {
    readonly kind: "directory";
}

type WalkEntry = WalkEntryFile | WalkEntryDirectory;

/**
 * Shared recursion skeleton for nested jsonl session trees. The presets differ
 * only in how they list/classify paths, preserving provider-specific error and
 * symlink semantics.
 *
 * The Claude parser (`ingestTranscripts` in transcripts.ts) intentionally does
 * NOT use this skeleton: its layout is flat (`<project-slug>/<session>.jsonl`,
 * exactly one level, no recursion) and it must keep the full `(mtime, size)`
 * stat per file for the skip-unchanged ingest watermark, whereas this walker
 * only consumes mtime/size for the `--since` cutoff and discards them.
 */
const walkJsonlCore = <E, R>(input: {
    readonly root: string;
    readonly cutoffMs: number;
    readonly listDir: (dir: string) => Effect.Effect<readonly string[], E, R>;
    readonly classifyEntry: (path: string) => Effect.Effect<Option.Option<WalkEntry>, E, R>;
    readonly joinPath: (dir: string, entry: string) => string;
}): Effect.Effect<JsonlFileCandidate[], E, R> =>
    Effect.gen(function* () {
        const out: JsonlFileCandidate[] = [];

        const visit = (dir: string): Effect.Effect<void, E, R> =>
            Effect.gen(function* () {
                const entries = yield* input.listDir(dir);
                for (const entry of entries) {
                    const full = input.joinPath(dir, entry);
                    const classified = yield* input.classifyEntry(full);
                    if (Option.isNone(classified)) continue;

                    const info = classified.value;
                    if (info.kind === "directory") {
                        yield* visit(full);
                    } else if (full.endsWith(".jsonl")) {
                        if (input.cutoffMs > 0 && info.mtimeMs < input.cutoffMs) continue;
                        out.push({ path: full, sizeBytes: info.sizeBytes });
                    }
                }
            });

        yield* visit(input.root);
        return out;
    });

/**
 * Codex semantics: `fs.stat` follows symlinks; NotFound dirs/entries are
 * skipped; every other PlatformError propagates.
 */
export const walkJsonlFilesStrict = (
    root: string,
    cutoffMs: number,
): Effect.Effect<JsonlFileCandidate[], PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        return yield* walkJsonlCore<PlatformError.PlatformError, never>({
            root,
            cutoffMs,
            joinPath: (dir, entry) => path.join(dir, entry),
            listDir: (dir) => fs.readDirectory(dir).pipe(skipNotFound([] as string[])),
            classifyEntry: (full) =>
                fs.stat(full).pipe(
                    Effect.map((stats) =>
                        stats.type === "Directory"
                            ? Option.some<WalkEntry>({ kind: "directory" })
                            : stats.type === "File"
                              ? Option.some<WalkEntry>({
                                    kind: "file",
                                    mtimeMs: Option.getOrElse(stats.mtime, () => new Date(0)).getTime(),
                                    sizeBytes: Number(stats.size),
                                })
                              : Option.none<WalkEntry>(),
                    ),
                    skipNotFound(Option.none<WalkEntry>()),
                ),
        });
    });

/**
 * Pi semantics: classify entries without following symlinks and absorb every
 * PlatformError as "absent"; callers ignore `sizeBytes`.
 */
export const walkJsonlFilesLenient = (
    root: string,
    cutoffMs: number,
): Effect.Effect<JsonlFileCandidate[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        return yield* walkJsonlCore<never, FileSystem.FileSystem>({
            root,
            cutoffMs,
            joinPath: (dir, entry) => path.join(dir, entry),
            listDir: (dir) => fs.readDirectory(dir).pipe(orAbsent([] as string[])),
            classifyEntry: (full) =>
                classifyNoFollow(full).pipe(
                    Effect.flatMap((kind) => {
                        if (kind === "Directory") {
                            return Effect.succeed(Option.some<WalkEntry>({ kind: "directory" }));
                        }
                        if (kind !== "File") return Effect.succeed(Option.none<WalkEntry>());

                        return fs.stat(full).pipe(
                            Effect.map((stats) =>
                                Option.some<WalkEntry>({
                                    kind: "file",
                                    mtimeMs: Option.getOrElse(stats.mtime, () => new Date(0)).getTime(),
                                    sizeBytes: Number(stats.size),
                                }),
                            ),
                            orAbsent(Option.none<WalkEntry>()),
                        );
                    }),
                ),
        });
    });
