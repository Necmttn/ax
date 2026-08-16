/**
 * Detect new transcript files for a Claude project slug that haven't been
 * ingested yet. Used by `ax sessions here|near` (P1.4): when the DB lags
 * behind on-disk transcripts, the command can auto-backfill (small delta)
 * or warn the user (large delta) instead of silently returning stale rows.
 */
import { Effect, FileSystem, Path, Schema } from "effect";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { CacheRead, type CacheReadError } from "./duckdb/seam.ts";

export interface StalenessReport {
    /** Absolute paths of jsonl files on disk that have no matching session.raw_file row. */
    readonly newFiles: ReadonlyArray<string>;
    /** Total .jsonl files in the project transcript dir. */
    readonly totalOnDisk: number;
    /** Total sessions in the cache for this project slug with a raw_file. */
    readonly totalInDb: number;
}

/**
 * Compare on-disk transcripts vs DB session rows for a given Claude project
 * slug. Returns the list of jsonl files that the DB doesn't know about yet.
 *
 * - `transcriptsDir`: root path (e.g. ~/.claude/projects).
 * - `project`: encoded slug (e.g. -Users-necmttn-Projects-ax).
 */
const RawFileRow = Schema.Struct({ raw_file: Schema.NullOr(Schema.String) });

export const detectStaleness = (opts: {
    readonly transcriptsDir: string;
    readonly project: string;
}): Effect.Effect<
    StalenessReport,
    CacheReadError,
    CacheRead | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = path.join(opts.transcriptsDir, opts.project);

        // OLD: readdir(projectDir) in try/catch → return []. A missing or
        // unreadable project dir means "nothing on disk to compare", so recover
        // ANY PlatformError to [] - orAbsent.
        const entries = yield* fs.readDirectory(projectDir).pipe(orAbsent([] as string[]));
        const onDisk = entries
            .filter((e) => e.endsWith(".jsonl"))
            .map((e) => path.join(projectDir, e));

        // `seenBasenames` being empty is NOT a benign default: every file on
        // disk then reads as new, forever, and the caller auto-backfills or
        // warns on every invocation. So this read must fail loudly rather than
        // degrade - hence `cache.rows` straight through, with `CacheReadError`
        // in the error channel instead of a catch to `[]`.
        const rows = yield* cache.rows(
            RawFileRow,
            "SELECT raw_file FROM session WHERE project = ? AND raw_file IS NOT NULL",
            [opts.project],
        );

        // Build a set of bare filenames the cache has seen. `raw_file` is
        // stored either as the original absolute path or as a bucket pointer
        // like `transcripts:/<id>.jsonl` - compare on basename to be robust.
        const seenBasenames = new Set<string>();
        for (const row of rows) {
            const v = row.raw_file;
            if (typeof v !== "string" || v.length === 0) continue;
            const base = v.includes("/") ? v.slice(v.lastIndexOf("/") + 1) : v;
            seenBasenames.add(base);
        }

        const newFiles = onDisk.filter((p) => {
            const base = p.slice(p.lastIndexOf("/") + 1);
            return !seenBasenames.has(base);
        });

        return {
            newFiles,
            totalOnDisk: onDisk.length,
            totalInDb: seenBasenames.size,
        };
    });
