import { Effect, FileSystem, Path } from "effect";
import { SurrealClient } from "./db.ts";
import { skipNotFound } from "./shared/fs-error.ts";

const FILE_BUCKETS = ["transcripts", "codex_artifacts"] as const;

export interface BlobGcResult {
    readonly scanned: number;
    readonly removed: number;
}

/** Remove local file-bucket blobs that no session row references. */
export const gcFileBuckets = Effect.fn("blobGc.gcFileBuckets")(function* (
    bucketsDir: string,
) {
    const db = yield* SurrealClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [rows] = yield* db.query<[Array<{ raw_file: unknown }>]>(
        "SELECT raw_file FROM session WHERE raw_file IS NOT NONE;",
    );
    const referenced = new Set(
        (rows ?? [])
            .map((row) => row.raw_file)
            .filter((value): value is string => typeof value === "string"),
    );

    let scanned = 0;
    let removed = 0;
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
            if (referenced.has(`${bucket}:/${entry}`)) continue;
            yield* fs.remove(filePath);
            removed += 1;
        }
    }

    return { scanned, removed } satisfies BlobGcResult;
});
