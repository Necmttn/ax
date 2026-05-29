import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStaleness } from "./transcript-staleness.ts";
import { SurrealClient, type SurrealClientShape } from "./db.ts";

type Capture = { sql: string; bindings: Record<string, unknown> | undefined };

const makeMockDb = (
    seenRows: ReadonlyArray<{ raw_file: string }>,
): { layer: Layer.Layer<SurrealClient>; captured: Capture[] } => {
    const captured: Capture[] = [];
    const impl: SurrealClientShape = {
        query: (sql, bindings) => {
            captured.push({ sql, bindings });
            return Effect.succeed([seenRows] as never);
        },
        upsert: () => Effect.succeed(undefined),
        relate: () => Effect.succeed(undefined),
        putFile: () => Effect.succeed(undefined),
        getFile: () => Effect.succeed(""),
        raw: undefined as never,
    };
    return { layer: Layer.succeed(SurrealClient, impl), captured };
};

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

describe("detectStaleness", () => {
    test("returns empty newFiles when project dir does not exist", async () => {
        const { layer } = makeMockDb([]);
        const result = await run(
            detectStaleness({ transcriptsDir: "/nonexistent/path", project: "-no-such-project" }),
            layer,
        );
        expect(result.newFiles).toEqual([]);
        expect(result.totalOnDisk).toBe(0);
        expect(result.totalInDb).toBe(0);
    });

    test("flags jsonl files on disk that the DB has not seen", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-staleness-"));
        const projectDir = join(dir, "-Users-x-Projects-ax");
        await mkdir(projectDir);
        await writeFile(join(projectDir, "abc-1.jsonl"), "");
        await writeFile(join(projectDir, "def-2.jsonl"), "");
        await writeFile(join(projectDir, "ghi-3.jsonl"), "");
        // unrelated file should be ignored
        await writeFile(join(projectDir, "README.md"), "");

        // DB has seen the first one only.
        const { layer, captured } = makeMockDb([{ raw_file: "/some/abs/path/abc-1.jsonl" }]);
        const result = await run(
            detectStaleness({ transcriptsDir: dir, project: "-Users-x-Projects-ax" }),
            layer,
        );

        expect(result.totalOnDisk).toBe(3);
        expect(result.totalInDb).toBe(1);
        expect(result.newFiles.length).toBe(2);
        expect(result.newFiles.map((p) => p.split("/").pop()).sort()).toEqual(["def-2.jsonl", "ghi-3.jsonl"]);

        expect(captured[0]!.sql).toContain("FROM session");
        expect(captured[0]!.bindings?.["project"]).toBe("-Users-x-Projects-ax");

        await rm(dir, { recursive: true, force: true });
    });

    test("matches on basename so bucket pointers and absolute paths both register", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-staleness-"));
        const projectDir = join(dir, "-p");
        await mkdir(projectDir);
        await writeFile(join(projectDir, "sess-1.jsonl"), "");
        await writeFile(join(projectDir, "sess-2.jsonl"), "");

        const { layer } = makeMockDb([
            { raw_file: "transcripts:/sess-1.jsonl" },
            { raw_file: "/abs/path/sess-2.jsonl" },
        ]);
        const result = await run(
            detectStaleness({ transcriptsDir: dir, project: "-p" }),
            layer,
        );

        expect(result.newFiles).toEqual([]);
        expect(result.totalInDb).toBe(2);

        await rm(dir, { recursive: true, force: true });
    });

    test("ignores DB rows with NONE/empty raw_file", async () => {
        const dir = await mkdtemp(join(tmpdir(), "ax-staleness-"));
        const projectDir = join(dir, "-p");
        await mkdir(projectDir);
        await writeFile(join(projectDir, "x.jsonl"), "");

        const { layer } = makeMockDb([
            { raw_file: "" } as { raw_file: string },
            { raw_file: "x.jsonl" },
        ]);
        const result = await run(
            detectStaleness({ transcriptsDir: dir, project: "-p" }),
            layer,
        );

        expect(result.newFiles).toEqual([]);
        expect(result.totalInDb).toBe(1);

        await rm(dir, { recursive: true, force: true });
    });
});
