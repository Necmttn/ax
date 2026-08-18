/**
 * `detectStaleness` against a REAL published DuckDB snapshot.
 *
 * A route-table fake that answers whatever rows a test case hands it would
 * pass here even when the real read path returns nothing: `seenBasenames`
 * being empty makes EVERY transcript read as new - a wrong answer with no
 * error anywhere. So the rows come from a snapshot the seam actually
 * published, not a stub.
 */
import { describe, expect } from "bun:test";
import { Effect, FileSystem, Layer, Path } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { duckdbTestSetup } from "./testing/duckdb-dylib.ts";
import {
    publishCacheFixture,
    readFixture,
    runWithPlatform,
    type CacheFixture,
} from "./testing/cache-fixture.ts";
import type { CacheRead, CacheWriteService } from "./duckdb/seam.ts";
import { detectStaleness } from "./transcript-staleness.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("transcript-staleness", { requireFts: true });

const FsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

/** Publish a snapshot whose `session` rows carry the given raw_file values. */
const publish = (
    prefix: string,
    project: string,
    rawFiles: ReadonlyArray<string | null>,
): Promise<CacheFixture> =>
    runWithPlatform(
        publishCacheFixture(tempDir(prefix), dylibPath, (write: CacheWriteService) =>
            write.putMany(
                "session",
                rawFiles.map((raw_file, i) => ({
                    id: `session-${i}`,
                    source: "claude",
                    project,
                    raw_file,
                })),
            ),
        ),
    );

const run = <A>(
    fixture: CacheFixture,
    eff: Effect.Effect<A, unknown, CacheRead | FileSystem.FileSystem | Path.Path>,
): Promise<A> =>
    Effect.runPromise(
        eff.pipe(
            Effect.provide(Layer.merge(readFixture(fixture.snapshotPath, dylibPath), FsLayer)),
        ) as Effect.Effect<A, unknown>,
    );

describe("detectStaleness", () => {
    dtest("returns empty newFiles when project dir does not exist", async () => {
        const fixture = await publish("ax-staleness-none-", "-p", []);
        const result = await run(
            fixture,
            detectStaleness({ transcriptsDir: "/nonexistent/path", project: "-no-such-project" }),
        );
        expect(result.newFiles).toEqual([]);
        expect(result.totalOnDisk).toBe(0);
        expect(result.totalInDb).toBe(0);
    }, 60_000);

    dtest("flags jsonl files on disk that the cache has not seen", async () => {
        const dir = tempDir("ax-staleness-");
        const projectDir = join(dir, "-Users-x-Projects-ax");
        await mkdir(projectDir);
        await writeFile(join(projectDir, "abc-1.jsonl"), "");
        await writeFile(join(projectDir, "def-2.jsonl"), "");
        await writeFile(join(projectDir, "ghi-3.jsonl"), "");
        // unrelated file should be ignored
        await writeFile(join(projectDir, "README.md"), "");

        const fixture = await publish("ax-staleness-cache-", "-Users-x-Projects-ax", [
            "/some/abs/path/abc-1.jsonl",
        ]);
        const result = await run(
            fixture,
            detectStaleness({ transcriptsDir: dir, project: "-Users-x-Projects-ax" }),
        );

        expect(result.totalOnDisk).toBe(3);
        expect(result.totalInDb).toBe(1);
        expect(result.newFiles.map((p) => p.split("/").pop()).sort()).toEqual([
            "def-2.jsonl",
            "ghi-3.jsonl",
        ]);
    }, 60_000);

    dtest("a project the cache has never seen reports every file as new", async () => {
        // The negative control for the defect this port fixes. Same disk state
        // as the case above; only the project filter differs, so a reader that
        // silently returns nothing is indistinguishable from this result - which
        // is why the case above must ALSO pass.
        const dir = tempDir("ax-staleness-miss-");
        const projectDir = join(dir, "-Users-x-Projects-ax");
        await mkdir(projectDir);
        await writeFile(join(projectDir, "abc-1.jsonl"), "");

        const fixture = await publish("ax-staleness-miss-cache-", "-someone-else", [
            "/some/abs/path/abc-1.jsonl",
        ]);
        const result = await run(
            fixture,
            detectStaleness({ transcriptsDir: dir, project: "-Users-x-Projects-ax" }),
        );

        expect(result.totalInDb).toBe(0);
        expect(result.newFiles.map((p) => p.split("/").pop())).toEqual(["abc-1.jsonl"]);
    }, 60_000);

    dtest("matches on basename so bucket pointers and absolute paths both register", async () => {
        const dir = tempDir("ax-staleness-base-");
        const projectDir = join(dir, "-p");
        await mkdir(projectDir);
        await writeFile(join(projectDir, "sess-1.jsonl"), "");
        await writeFile(join(projectDir, "sess-2.jsonl"), "");

        const fixture = await publish("ax-staleness-base-cache-", "-p", [
            "transcripts:/sess-1.jsonl",
            "/abs/path/sess-2.jsonl",
        ]);
        const result = await run(fixture, detectStaleness({ transcriptsDir: dir, project: "-p" }));

        expect(result.newFiles).toEqual([]);
        expect(result.totalInDb).toBe(2);
    }, 60_000);

    dtest("ignores rows with a null or empty raw_file", async () => {
        const dir = tempDir("ax-staleness-null-");
        const projectDir = join(dir, "-p");
        await mkdir(projectDir);
        await writeFile(join(projectDir, "x.jsonl"), "");

        const fixture = await publish("ax-staleness-null-cache-", "-p", [null, "", "x.jsonl"]);
        const result = await run(fixture, detectStaleness({ transcriptsDir: dir, project: "-p" }));

        expect(result.newFiles).toEqual([]);
        expect(result.totalInDb).toBe(1);
    }, 60_000);
});
