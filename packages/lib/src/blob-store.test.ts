import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { blobName, putBlobFromFile } from "./blob-store.ts";
import { isBlobPointer } from "./blob-pointer.ts";

const PlatformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

/** Fail `copyFile` for every path, to exercise the best-effort branch against a
 *  genuine `PlatformError` rather than a permission-bit trick that behaves
 *  differently for root-run CI. */
const withFailingCopy = (): Layer.Layer<FileSystem.FileSystem> =>
    Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
            ...fs,
            copyFile: (from: string, to: string) =>
                Effect.fail(
                    PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "copyFile",
                        pathOrDescriptor: `${from} -> ${to}`,
                    }),
                ),
        })),
    ).pipe(Layer.provide(BunFileSystem.layer));

const inTempDir = <A>(
    body: (
        root: string,
        source: string,
    ) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>,
    layer: Layer.Layer<FileSystem.FileSystem | Path.Path> = PlatformLayer,
): Promise<A> =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const source = path.join(root, "session.jsonl");
        yield* fs.writeFileString(source, "line-1\nline-2\n");
        return yield* body(path.join(root, "buckets"), source);
    })).pipe(Effect.provide(layer)) as Effect.Effect<A>);

describe("blobName", () => {
    test("keeps a plain session id and appends the extension", () => {
        expect(blobName("019a3f10-8c22-7000-9000-abc", ".jsonl"))
            .toBe("019a3f10-8c22-7000-9000-abc.jsonl");
    });

    test("collapses separators, so the name stays ONE path segment", () => {
        // A name holding a `/` would make GC rebuild a pointer no reference set
        // can match, and delete the file on its next global pass.
        expect(blobName("session:../../etc/passwd", ".jsonl"))
            .toBe("session_.._.._etc_passwd.jsonl");
    });

    test("an empty id still yields a usable name", () => {
        expect(blobName("", ".jsonl")).toBe("unnamed.jsonl");
    });
});

describe("putBlobFromFile", () => {
    test("copies the source into the bucket and returns a well-formed pointer", async () => {
        const result = await inTempDir((buckets, source) => Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const pointer = yield* putBlobFromFile(
                buckets,
                "transcripts",
                "abc.jsonl",
                source,
                { maxBytes: 1024, sizeBytes: 14 },
            );
            const written = path.join(buckets, "transcripts", "abc.jsonl");
            return {
                pointer,
                content: yield* fs.readFileString(written),
                // The `.partial` staging file must never survive a good copy.
                partial: yield* fs.exists(`${written}.partial`),
            };
        }));

        expect(result.pointer as string | null).toBe("transcripts:/abc.jsonl");
        expect(isBlobPointer(result.pointer ?? "")).toBe(true);
        expect(result.content).toBe("line-1\nline-2\n");
        expect(result.partial).toBe(false);
    });

    test("skips a source larger than maxBytes and writes nothing", async () => {
        const result = await inTempDir((buckets, source) => Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const pointer = yield* putBlobFromFile(
                buckets,
                "transcripts",
                "big.jsonl",
                source,
                { maxBytes: 4, sizeBytes: 14 },
            );
            return { pointer, bucketExists: yield* fs.exists(buckets) };
        }));

        expect(result.pointer).toBeNull();
        expect(result.bucketExists).toBe(false);
    });

    test("maxBytes 0 disables snapshotting entirely", async () => {
        const pointer = await inTempDir((buckets, source) =>
            putBlobFromFile(buckets, "transcripts", "off.jsonl", source, {
                maxBytes: 0,
                sizeBytes: 1,
            }),
        );
        expect(pointer).toBeNull();
    });

    test("stats the source when the caller does not know its size", async () => {
        const pointer = await inTempDir((buckets, source) =>
            putBlobFromFile(buckets, "transcripts", "stat.jsonl", source, { maxBytes: 4 }),
        );
        // 14 bytes on disk against a 4-byte cap - the cap must be applied to the
        // stat'd size, not waved through as "caller said nothing".
        expect(pointer).toBeNull();
    });

    test("a missing source is skipped, not fatal", async () => {
        const pointer = await inTempDir((buckets, source) =>
            putBlobFromFile(
                buckets,
                "transcripts",
                "gone.jsonl",
                `${source}.does-not-exist`,
                { maxBytes: 1024, sizeBytes: 1 },
            ),
        );
        expect(pointer).toBeNull();
    });

    test("a copy failure returns null and leaves no .partial behind", async () => {
        const result = await inTempDir(
            (buckets, source) => Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const path = yield* Path.Path;
                const pointer = yield* putBlobFromFile(
                    buckets,
                    "codex_artifacts",
                    "fail.jsonl",
                    source,
                    { maxBytes: 1024, sizeBytes: 14 },
                );
                const dir = path.join(buckets, "codex_artifacts");
                return {
                    pointer,
                    entries: yield* fs.readDirectory(dir),
                };
            }),
            Layer.mergeAll(withFailingCopy(), BunPath.layer),
        );

        expect(result.pointer).toBeNull();
        expect(result.entries).toEqual([]);
    });
});
