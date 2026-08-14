import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Path } from "effect";
import { gcFileBuckets } from "./blob-gc.ts";
import { makeTestSurrealClient } from "./testing/surreal.ts";

const PlatformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

describe("gcFileBuckets", () => {
    test("removes unreferenced blobs and keeps referenced blobs", async () => {
        const db = makeTestSurrealClient({
            routes: {
                "SELECT raw_file FROM session": [[
                    { raw_file: "transcripts:/keep.jsonl" },
                    { raw_file: "codex_artifacts:/keep.jsonl" },
                    { raw_file: "/source/transcript.jsonl" },
                ]],
            },
        });

        const layer = Layer.mergeAll(db.layer, PlatformLayer);
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

            const result = yield* gcFileBuckets(root);

            expect(result).toEqual({ scanned: 4, removed: 2 });
            expect(yield* fs.exists(path.join(transcripts, "keep.jsonl"))).toBe(true);
            expect(yield* fs.exists(path.join(codex, "keep.jsonl"))).toBe(true);
            expect(yield* fs.exists(path.join(transcripts, "orphan.jsonl"))).toBe(false);
            expect(yield* fs.exists(path.join(codex, "orphan.jsonl"))).toBe(false);
        }).pipe(Effect.provide(layer))));
    });
});
