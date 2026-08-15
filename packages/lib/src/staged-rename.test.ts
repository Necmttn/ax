import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageAndRename } from "./staged-rename.ts";

/** A temp directory removed when `body` finishes, however it finishes. */
const withTempDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "ax-staged-rename-"));
    try {
        await body(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<A, E>);

/** The caller-typed error every case below maps filesystem faults into, so the
 *  primitive's error channel is exactly `E` and never a leaked PlatformError. */
class StageFailed {
    readonly _tag = "StageFailed";
    constructor(readonly why: string) {}
}

const writeText = (fs: FileSystem.FileSystem, text: string) => (tmp: string) =>
    fs.writeFileString(tmp, text).pipe(Effect.mapError(() => new StageFailed("write")));

describe("stageAndRename", () => {
    test("publishes the staged bytes at the target", async () => {
        await withTempDir(async (dir) => {
            const target = join(dir, "out.txt");
            await run(
                Effect.gen(function* () {
                    const fs = yield* FileSystem.FileSystem;
                    yield* stageAndRename<StageFailed, never>(target, {
                        stage: writeText(fs, "published"),
                        onFsError: (step) => new StageFailed(step),
                    });
                }),
            );
            expect(readFileSync(target, "utf8")).toBe("published");
        });
    });

    test("creates a missing parent directory", async () => {
        await withTempDir(async (dir) => {
            const target = join(dir, "nested", "deeper", "out.txt");
            await run(
                Effect.gen(function* () {
                    const fs = yield* FileSystem.FileSystem;
                    yield* stageAndRename<StageFailed, never>(target, {
                        stage: writeText(fs, "nested"),
                        onFsError: (step) => new StageFailed(step),
                    });
                }),
            );
            expect(readFileSync(target, "utf8")).toBe("nested");
        });
    });

    test("leaves an existing target untouched when staging fails, and removes the temp file", async () => {
        await withTempDir(async (dir) => {
            const target = join(dir, "out.txt");
            await Bun.write(target, "original");

            const exit = await Effect.runPromiseExit(
                stageAndRename<StageFailed, never>(target, {
                    stage: () => Effect.fail(new StageFailed("boom")),
                    onFsError: (step) => new StageFailed(step),
                }).pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<void, StageFailed>,
            );

            expect(exit._tag).toBe("Failure");
            // The target is exactly as it was...
            expect(readFileSync(target, "utf8")).toBe("original");
            // ...and no `.tmp` litter is left behind.
            expect(readdirSync(dir)).toEqual(["out.txt"]);
        });
    });

    test("removes the temp file when the rename itself fails", async () => {
        await withTempDir(async (dir) => {
            // A directory at the target path makes rename(file -> dir) fail
            // without any mocking: the primitive's own step is the one that breaks.
            const target = join(dir, "occupied");
            await Bun.write(join(target, "child.txt"), "in the way");

            const exit = await Effect.runPromiseExit(
                Effect.gen(function* () {
                    const fs = yield* FileSystem.FileSystem;
                    yield* stageAndRename<StageFailed, never>(target, {
                        stage: writeText(fs, "never lands"),
                        onFsError: (step) => new StageFailed(step),
                    });
                }).pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<void, StageFailed>,
            );

            expect(exit._tag).toBe("Failure");
            expect(readdirSync(dir)).toEqual(["occupied"]);
            expect(existsSync(join(target, "child.txt"))).toBe(true);
        });
    });

    test("runs beforeRename while the temp file exists and afterRename once the target does", async () => {
        await withTempDir(async (dir) => {
            const target = join(dir, "out.txt");
            const observed: Array<string> = [];

            await run(
                Effect.gen(function* () {
                    const fs = yield* FileSystem.FileSystem;
                    yield* stageAndRename<StageFailed, never>(target, {
                        stage: writeText(fs, "v2"),
                        beforeRename: (tmp) =>
                            Effect.sync(() => {
                                observed.push(`before:tmp=${existsSync(tmp)}:target=${existsSync(target)}`);
                            }),
                        afterRename: Effect.sync(() => {
                            observed.push(`after:target=${existsSync(target)}`);
                        }),
                        onFsError: (step) => new StageFailed(step),
                    });
                }),
            );

            expect(observed).toEqual(["before:tmp=true:target=false", "after:target=true"]);
        });
    });

    test("two concurrent publishes of the same target both land, neither observing a partial file", async () => {
        await withTempDir(async (dir) => {
            const target = join(dir, "out.txt");
            const body = (text: string) =>
                Effect.gen(function* () {
                    const fs = yield* FileSystem.FileSystem;
                    yield* stageAndRename<StageFailed, never>(target, {
                        stage: writeText(fs, text),
                        onFsError: (step) => new StageFailed(step),
                    });
                });

            await run(
                Effect.all([body("aaaa"), body("bbbb")], { concurrency: "unbounded" }).pipe(Effect.asVoid),
            );

            // Whichever rename landed last wins; the point is that the file is
            // one of the two COMPLETE payloads, never a mix, and no temp file
            // survived either fiber.
            expect(["aaaa", "bbbb"]).toContain(readFileSync(target, "utf8"));
            expect(readdirSync(dir)).toEqual(["out.txt"]);
        });
    });

    test("a failure in beforeRename leaves the target untouched", async () => {
        await withTempDir(async (dir) => {
            const target = join(dir, "out.txt");
            await Bun.write(target, "original");

            const exit = await Effect.runPromiseExit(
                Effect.gen(function* () {
                    const fs = yield* FileSystem.FileSystem;
                    yield* stageAndRename<StageFailed, never>(target, {
                        stage: writeText(fs, "candidate"),
                        beforeRename: () => Effect.fail(new StageFailed("backup")),
                        onFsError: (step) => new StageFailed(step),
                    });
                }).pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<void, StageFailed>,
            );

            expect(exit._tag).toBe("Failure");
            expect(readFileSync(target, "utf8")).toBe("original");
            expect(readdirSync(dir)).toEqual(["out.txt"]);
        });
    });
});
