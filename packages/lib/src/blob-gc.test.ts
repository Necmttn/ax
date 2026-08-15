import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { filePointer } from "./blob-pointer.ts";
import { cacheReferencedBlobs, gcFileBuckets } from "./blob-gc.ts";
import { publishCacheFixture, readFixture, runWithPlatform } from "./testing/cache-fixture.ts";
import { duckdbTestSetup } from "./testing/duckdb-dylib.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("blob gc", { requireFts: true });

const PlatformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/**
 * A `CacheRead` layer over a real published cache whose `session` rows carry
 * `raw_file` pointers.
 *
 * The reference set is the ONLY thing GC reads from the graph, and it is the
 * thing a deletion pass must never get wrong - so it comes from a real cache
 * rather than a canned response. `session_ref` is a plain VARCHAR here, which is
 * the point of the port: the Surreal query filtered `IS NOT NONE`, a value that
 * does not exist in DuckDB.
 */
const referencedFrom = async (
    rawFiles: ReadonlyArray<string | null>,
    name: string,
): Promise<ReadonlySet<string>> => {
    const fixture = await runWithPlatform(
        publishCacheFixture(tempDir(name), dylibPath, (w) =>
            rawFiles.length === 0
                ? Effect.void
                : w.putMany(
                      "session",
                      rawFiles.map((raw, i) => ({ id: `session-${i}`, raw_file: raw })),
                  ),
        ),
    );
    return Effect.runPromise(
        cacheReferencedBlobs.pipe(
            Effect.provide(readFixture(fixture.snapshotPath, dylibPath)),
        ) as Effect.Effect<ReadonlySet<string>>,
    );
};

/** Wrap the real BunFileSystem, failing `remove` for exactly one path so F9
 *  (per-file remove failures continue the loop) can be exercised against a
 *  genuine `PlatformError` instead of a permission-bit trick that behaves
 *  differently for root-run CI. Every other operation delegates to the real
 *  filesystem untouched. */
const withFailingRemove = (failPath: string): Layer.Layer<FileSystem.FileSystem> =>
    Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
            ...fs,
            remove: (path: string, opts?: Parameters<FileSystem.FileSystem["remove"]>[1]) =>
                path === failPath
                    ? Effect.fail(
                        PlatformError.systemError({
                            _tag: "PermissionDenied",
                            module: "FileSystem",
                            method: "remove",
                            pathOrDescriptor: path,
                        }),
                    )
                    : fs.remove(path, opts),
        })),
    ).pipe(Layer.provide(BunFileSystem.layer));

describe("gcFileBuckets", () => {
    dtest("removes unreferenced blobs (age guard disabled) and keeps referenced blobs", async () => {
        const referenced = await referencedFrom(
            [
                filePointer("transcripts", "keep.jsonl"),
                filePointer("codex_artifacts", "keep.jsonl"),
                "/source/transcript.jsonl",
            ],
            "ax-blobgc-basic-",
        );

        const layer = PlatformLayer;
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const transcripts = path.join(root, "transcripts");
            const codex = path.join(root, "codex_artifacts");
            yield* fs.makeDirectory(transcripts);
            yield* fs.makeDirectory(codex);
            yield* fs.writeFileString(path.join(transcripts, "keep.jsonl"), "keep");
            yield* fs.writeFileString(path.join(transcripts, "orphan.jsonl"), "remove");
            yield* fs.writeFileString(path.join(codex, "keep.jsonl"), "keep");
            yield* fs.writeFileString(path.join(codex, "orphan.jsonl"), "remove");

            // Orphans are freshly written (age ~0), so disable the young-blob
            // guard here - it's covered by its own test below.
            const result = yield* gcFileBuckets(root, { isGlobalIngest: true, referenced, minAgeMs: 0 });

            expect(result).toEqual({ scanned: 4, removed: 2, failed: 0, skipped: false });
            expect(yield* fs.exists(path.join(transcripts, "keep.jsonl"))).toBe(true);
            expect(yield* fs.exists(path.join(codex, "keep.jsonl"))).toBe(true);
            expect(yield* fs.exists(path.join(transcripts, "orphan.jsonl"))).toBe(false);
            expect(yield* fs.exists(path.join(codex, "orphan.jsonl"))).toBe(false);
        }).pipe(Effect.provide(layer))));
    });

    dtest("skips entirely for a scoped (partial) ingest run", async () => {
        const referenced = await referencedFrom(
            [filePointer("transcripts", "keep.jsonl")],
            "ax-blobgc-",
        );
        const layer = PlatformLayer;

        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const transcripts = path.join(root, "transcripts");
            yield* fs.makeDirectory(transcripts);
            yield* fs.writeFileString(path.join(transcripts, "orphan.jsonl"), "remove");

            const result = yield* gcFileBuckets(root, { isGlobalIngest: false, referenced });

            expect(result.skipped).toBe(true);
            expect(result.skipReason).toMatch(/scoped/);
            expect(result.scanned).toBe(0);
            expect(result.removed).toBe(0);
            // A scoped run must never touch disk - the orphan survives.
            expect(yield* fs.exists(path.join(transcripts, "orphan.jsonl"))).toBe(true);
        }).pipe(Effect.provide(layer))));
    });

    dtest("skips when the session reference set is empty", async () => {
        // Sessions with no raw_file pointers at all - what a fresh or
        // partially-ingested graph looks like, and the same shape a failed read
        // degrades to.
        const referenced = await referencedFrom([null, null], "ax-blobgc-empty-");
        const layer = PlatformLayer;

        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const transcripts = path.join(root, "transcripts");
            yield* fs.makeDirectory(transcripts);
            yield* fs.writeFileString(path.join(transcripts, "orphan.jsonl"), "remove");

            const result = yield* gcFileBuckets(root, { isGlobalIngest: true, referenced });

            expect(result.skipped).toBe(true);
            expect(result.skipReason).toMatch(/empty/);
            // Refusing an empty reference set must never delete-everything.
            expect(yield* fs.exists(path.join(transcripts, "orphan.jsonl"))).toBe(true);
        }).pipe(Effect.provide(layer))));
    });

    dtest("spares an unreferenced blob younger than the age guard", async () => {
        const referenced = await referencedFrom(
            [filePointer("transcripts", "keep.jsonl")],
            "ax-blobgc-",
        );
        const layer = PlatformLayer;

        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const transcripts = path.join(root, "transcripts");
            yield* fs.makeDirectory(transcripts);
            yield* fs.writeFileString(path.join(transcripts, "keep.jsonl"), "keep");
            yield* fs.writeFileString(path.join(transcripts, "young-orphan.jsonl"), "remove");

            // Default 24h age guard, real "now" - the orphan was just written.
            const result = yield* gcFileBuckets(root, { isGlobalIngest: true, referenced });

            expect(result.skipped).toBe(false);
            expect(result.removed).toBe(0);
            expect(result.scanned).toBe(2);
            expect(yield* fs.exists(path.join(transcripts, "young-orphan.jsonl"))).toBe(true);
        }).pipe(Effect.provide(layer))));
    });

    dtest("deletes an old unreferenced blob past the age guard", async () => {
        const referenced = await referencedFrom(
            [filePointer("transcripts", "keep.jsonl")],
            "ax-blobgc-",
        );
        const layer = PlatformLayer;

        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const transcripts = path.join(root, "transcripts");
            yield* fs.makeDirectory(transcripts);
            yield* fs.writeFileString(path.join(transcripts, "keep.jsonl"), "keep");
            yield* fs.writeFileString(path.join(transcripts, "old-orphan.jsonl"), "remove");

            // Simulate the clock 2 days ahead so the just-written orphan reads
            // as 2 days old against the 24h default guard.
            const twoDaysLater = () => Date.now() + 2 * 24 * 60 * 60 * 1000;
            const result = yield* gcFileBuckets(root, { isGlobalIngest: true, referenced, now: twoDaysLater });

            expect(result).toEqual({ scanned: 2, removed: 1, failed: 0, skipped: false });
            expect(yield* fs.exists(path.join(transcripts, "keep.jsonl"))).toBe(true);
            expect(yield* fs.exists(path.join(transcripts, "old-orphan.jsonl"))).toBe(false);
        }).pipe(Effect.provide(layer))));
    });

    dtest("a per-file remove failure is counted and does not abort the rest of GC", async () => {
        const referenced = await referencedFrom(
            [filePointer("transcripts", "keep.jsonl")],
            "ax-blobgc-fail-",
        );

        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped();
            const transcripts = path.join(root, "transcripts");
            const codex = path.join(root, "codex_artifacts");
            yield* fs.makeDirectory(transcripts);
            yield* fs.makeDirectory(codex);
            const failingOrphan = path.join(transcripts, "orphan-a.jsonl");
            const okOrphan = path.join(codex, "orphan-b.jsonl");
            yield* fs.writeFileString(failingOrphan, "remove");
            yield* fs.writeFileString(okOrphan, "remove");

            const layer = Layer.mergeAll(withFailingRemove(failingOrphan), BunPath.layer);
            const result = yield* gcFileBuckets(root, { isGlobalIngest: true, referenced, minAgeMs: 0 }).pipe(
                Effect.provide(layer),
            );

            expect(result.scanned).toBe(2);
            expect(result.failed).toBe(1);
            expect(result.removed).toBe(1);
            expect(result.skipped).toBe(false);
            // The failing remove left its file in place; the other bucket's
            // orphan was still removed - one bad file never aborts the loop.
            expect(yield* fs.exists(failingOrphan)).toBe(true);
            expect(yield* fs.exists(okOrphan)).toBe(false);
        }).pipe(Effect.provide(PlatformLayer))));
    });
});
