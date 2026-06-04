import { describe, it, expect } from "bun:test";
import { Effect, Exit, FileSystem, PlatformError, Stream } from "effect";
import { layerTestFileSystem } from "./test-filesystem.ts";

const run = <A, E>(
    eff: Effect.Effect<A, E, FileSystem.FileSystem>,
    files: Record<string, string>,
    opts?: { readonly errors?: Record<string, PlatformError.PlatformError> },
) => Effect.runPromise(Effect.provide(eff, layerTestFileSystem(files, opts)));

const runExit = <A, E>(
    eff: Effect.Effect<A, E, FileSystem.FileSystem>,
    files: Record<string, string>,
    opts?: { readonly errors?: Record<string, PlatformError.PlatformError> },
) => Effect.runPromiseExit(Effect.provide(eff, layerTestFileSystem(files, opts)));

describe("layerTestFileSystem", () => {
    it("serves seeded files via readFileString", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/seed/a.txt");
            }),
            { "/seed/a.txt": "hello" },
        );
        expect(out).toBe("hello");
    });

    it("streams seeded content as lines (multi-chunk, multi-byte safe)", async () => {
        // 'é' is 2 bytes (0xC3 0xA9); with a 3-byte chunker it splits across a
        // chunk boundary, exercising decodeText's cross-chunk buffering.
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const lines: string[] = [];
                yield* fs.stream("/seed/b.jsonl").pipe(
                    Stream.decodeText(),
                    Stream.splitLines,
                    Stream.runForEach((l) => Effect.sync(() => { lines.push(l); })),
                );
                return lines;
            }),
            { "/seed/b.jsonl": "café\nl2\nl3" },
        );
        expect(out).toEqual(["café", "l2", "l3"]);
    });

    it("trailing newline does not produce a trailing empty line (readLines parity)", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const lines: string[] = [];
                yield* fs.stream("/seed/c.jsonl").pipe(
                    Stream.decodeText(),
                    Stream.splitLines,
                    Stream.runForEach((l) => Effect.sync(() => { lines.push(l); })),
                );
                return lines;
            }),
            { "/seed/c.jsonl": "a\nb\n" },
        );
        expect(out).toEqual(["a", "b"]);
    });

    it("missing file -> PlatformError NotFound, catchable via catchTag", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/nope").pipe(
                    Effect.catchTag("PlatformError", (e) =>
                        e.reason._tag === "NotFound" ? Effect.succeed("SKIPPED") : Effect.fail(e),
                    ),
                );
            }),
            {},
        );
        expect(out).toBe("SKIPPED");
    });

    it("NEGATIVE: a non-NotFound PlatformError re-raises (not swallowed by the NotFound catch)", async () => {
        const perm = PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: "/locked",
        });
        const exit = await runExit(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/locked").pipe(
                    Effect.catchTag("PlatformError", (e) =>
                        e.reason._tag === "NotFound" ? Effect.succeed("SKIPPED") : Effect.fail(e),
                    ),
                );
            }),
            {},
            { errors: { "/locked": perm } },
        );
        expect(Exit.isFailure(exit)).toBe(true);
    });

    it("readDirectory lists immediate entries under a dir", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readDirectory("/proj");
            }),
            { "/proj/a.jsonl": "x", "/proj/b.jsonl": "y", "/other/c.jsonl": "z" },
        );
        expect(out.sort()).toEqual(["a.jsonl", "b.jsonl"]);
    });
});
