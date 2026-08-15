import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { filePointer } from "./blob-pointer.ts";
import { cacheRows } from "./duckdb/query.ts";
import type { CacheRead } from "./duckdb/seam.ts";
import { orAbsent, skipNotFound } from "./shared/fs-error.ts";

const FILE_BUCKETS = ["transcripts", "codex_artifacts"] as const;

/** Never delete a blob written more recently than this - guards the window
 *  where a blob has just landed on disk (e.g. serve's live ingest, still
 *  mid-write) but its `session` row referencing it hasn't been upserted yet. */
const DEFAULT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface BlobGcResult {
    readonly scanned: number;
    readonly removed: number;
    /** `fs.remove` failures - counted, not fatal (F9): one bad file must not
     *  abort GC for every other candidate. */
    readonly failed: number;
    /** True when GC declined to run/delete anything this call - see
     *  `skipReason` for why. `scanned`/`removed`/`failed` are all 0 then. */
    readonly skipped: boolean;
    readonly skipReason?: string;
}

export interface BlobGcOptions {
    /**
     * Only actually delete when the triggering ingest run scanned EVERY
     * session - a truly GLOBAL ingest with no scope narrowing of any kind. The
     * reference set below is built from the CURRENT `session` table, so it is a
     * trustworthy "everything referenced" set ONLY when the run that populated
     * it was unscoped. Any narrowing makes the table a PARTIAL view and turns
     * every out-of-scope session's still-live blob into a false GC candidate:
     *   - `--since=` windowing (after a DB wipe + windowed re-ingest, the table
     *     holds only the windowed sessions);
     *   - repo/project scope (`ax ingest here`, an explicit project/claude
     *     project) - only that repo's sessions are touched, so another repo's
     *     blobs look unreferenced;
     *   - a `--stages=` subset that skips the session-writing stages entirely.
     * Running GC against any such partial view would permanently delete
     * cold-but-referenced blobs, so the caller must pass the single
     * `isGlobalIngest` predicate (see cli/commands/ingest.ts) here.
     */
    readonly isGlobalIngest: boolean;
    /**
     * Every blob pointer the session table currently references, read from the
     * engine THIS ingest run wrote - see {@link cacheReferencedBlobs} for why
     * the caller supplies it rather than GC reading it.
     *
     * An EMPTY set is refused below rather than treated as "nothing is
     * referenced": that is the shape a failed or unavailable read takes, and it
     * would delete every blob.
     */
    readonly referenced: ReadonlySet<string>;
    /** Override the young-blob guard window (ms). Defaults to 24h. */
    readonly minAgeMs?: number;
    readonly now?: () => number;
}

/** The one column GC reads. `WHERE raw_file IS NOT NULL` (the Surreal query said
 *  `IS NOT NONE`, a value DuckDB does not have) keeps the schema non-nullable,
 *  so a NULL slipping through is a decode failure rather than a `null` quietly
 *  entering the reference set and matching no file. */
const RawFileRow = Schema.Struct({ raw_file: Schema.String });

/**
 * The blob pointers the cache's `session` rows currently reference.
 *
 * THE CALLER SUPPLIES THE SET, and that is not ceremony. GC DELETES FILES, and
 * its whole safety argument is that the reference set came from the engine the
 * triggering ingest actually wrote. Reading it here, unconditionally, from the
 * published DuckDB snapshot was wrong while ingest still writes SurrealDB: the
 * snapshot omits everything the run in progress produced, so an ingest that had
 * just written a session's blob would find that blob unreferenced. Passing the
 * set in makes the engine a decision of the CALL SITE - the one place that knows
 * which engine the run wrote - instead of a fact baked into a deletion pass.
 *
 * This is the v2 source. It becomes the only one at the ingest write cutover;
 * until then the Surreal-era caller reads its own.
 */
export const cacheReferencedBlobs: Effect.Effect<ReadonlySet<string>, never, CacheRead> =
    Effect.map(
        cacheRows(
            RawFileRow,
            { sql: "SELECT raw_file FROM session WHERE raw_file IS NOT NULL", params: [] },
            "blob gc reference set",
        ),
        (rows) => new Set(rows.map((row) => row.raw_file)),
    );

const skip = (reason: string): BlobGcResult => ({
    scanned: 0,
    removed: 0,
    failed: 0,
    skipped: true,
    skipReason: reason,
});

/** Remove local file-bucket blobs that no session row references. */
export const gcFileBuckets = Effect.fn("blobGc.gcFileBuckets")(function* (
    bucketsDir: string,
    opts: BlobGcOptions,
) {
    if (!opts.isGlobalIngest) {
        return skip(
            "ingest run was scoped (--since / repo / --stages subset); the session table is not a " +
                "complete reference set, so blob GC was skipped to avoid deleting live blobs",
        );
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const referenced = opts.referenced;

    if (referenced.size === 0) {
        return skip(
            "the session reference set is empty (0 rows with raw_file); refusing to run blob GC " +
                "against an empty reference set, which would delete every blob",
        );
    }

    const now = opts.now ?? (() => Date.now());
    const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;

    let scanned = 0;
    let removed = 0;
    let failed = 0;
    for (const bucket of FILE_BUCKETS) {
        const bucketDir = path.join(bucketsDir, bucket);
        const entries = yield* fs.readDirectory(bucketDir).pipe(
            skipNotFound<ReadonlyArray<string>>([]),
        );
        for (const entry of entries) {
            const filePath = path.join(bucketDir, entry);
            const info = yield* fs.stat(filePath).pipe(skipNotFound(null));
            if (info === null || info.type !== "File") continue;
            scanned += 1;
            if (referenced.has(filePointer(bucket, entry))) continue;

            const ageMs = Option.match(info.mtime, {
                onNone: () => Number.POSITIVE_INFINITY,
                onSome: (mtime) => now() - mtime.getTime(),
            });
            if (ageMs < minAgeMs) continue; // young blob spared

            const ok = yield* fs.remove(filePath).pipe(
                Effect.as(true),
                orAbsent(false),
            );
            if (ok) removed += 1;
            else failed += 1;
        }
    }

    return { scanned, removed, failed, skipped: false } satisfies BlobGcResult;
});
