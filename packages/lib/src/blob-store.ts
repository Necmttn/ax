import { Effect, FileSystem, Path } from "effect";
import { filePointer } from "./blob-pointer.ts";

/**
 * Writing a raw transcript into a local file bucket, and getting back the
 * `<bucket>:/<name>` pointer that `session.raw_file` is contracted to hold.
 *
 * v1 did this through SurrealDB's `putFile` bucket API. v2 has no database
 * engine to ask, so the bucket is just a directory under the data dir and the
 * copy is a filesystem copy. That is not a downgrade: nothing ever read a blob
 * back THROUGH the engine (the pointer is a plain string by design - see
 * blob-pointer.ts), so the engine was only ever a file writer with extra steps.
 *
 * Snapshots are COLD STORAGE and nothing in ax fails without them. Harnesses
 * rotate and prune their own transcript directories, so the copy is the only
 * durable record of a session's raw bytes once the source is gone. Every
 * failure here is therefore best-effort: it logs and returns null, and the
 * caller keeps whatever fallback it had.
 */

/**
 * A blob's on-disk name must be one path segment: GC lists the bucket
 * directory and rebuilds each pointer as `filePointer(bucket, entry)`, so a
 * name holding a separator would produce a pointer no reference set can match
 * and a file GC would delete on its next global pass.
 */
export const blobName = (sessionId: string, extension: string): string => {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    return `${safe === "" ? "unnamed" : safe}${extension}`;
};

export interface PutBlobOptions {
    /**
     * Skip the copy when the source is larger than this. 0 disables
     * snapshotting entirely, which is how a user opts out of the disk cost.
     */
    readonly maxBytes: number;
    /** Source size the caller already stat'd, to save a second stat. */
    readonly sizeBytes?: number;
}

/**
 * Copy `sourcePath` into `<bucketsDir>/<bucket>/<name>` and return its pointer,
 * or null when the snapshot was skipped or failed.
 *
 * The copy lands on a `.partial` sibling first and is renamed into place, so a
 * reader (or GC) never observes a half-written blob under its final name. A
 * `.partial` left by a crashed run is not a blob GC candidate either: GC
 * rebuilds pointers from directory entries, finds `.partial` unreferenced, and
 * removes it once it is a day old.
 */
export const putBlobFromFile = Effect.fn("blobStore.putBlobFromFile")(function* (
    bucketsDir: string,
    bucket: string,
    name: string,
    sourcePath: string,
    opts: PutBlobOptions,
) {
    if (opts.maxBytes <= 0) return null;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const sizeBytes = opts.sizeBytes ?? (yield* fs.stat(sourcePath).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => Number.POSITIVE_INFINITY),
    ));
    if (sizeBytes > opts.maxBytes) return null;

    const dir = path.join(bucketsDir, bucket);
    const target = path.join(dir, name);
    const partial = `${target}.partial`;

    const written = yield* Effect.gen(function* () {
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.copyFile(sourcePath, partial);
        yield* fs.rename(partial, target);
        return true;
    }).pipe(
        Effect.catchTag("PlatformError", (err) =>
            Effect.gen(function* () {
                yield* Effect.logDebug("blob snapshot failed", {
                    bucket,
                    name,
                    source: sourcePath,
                    message: err.message,
                });
                // Leave no half-copy behind under a name a later run would
                // rename into place on top of.
                yield* Effect.ignore(fs.remove(partial));
                return false;
            }),
        ),
    );

    return written ? filePointer(bucket, name) : null;
});
