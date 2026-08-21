import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { hashFileSha256, importedMarkPath, WATERMARK_TABLE, watermarkRow } from "@ax/lib/duckdb/watermark";
import { parseDuckdbColumnDefs } from "@ax/schema/duckdb-ddl";
import type { CacheWriteError } from "@ax/lib/duckdb/seam";
import { makeTableSpool, withTableSpool } from "@ax/lib/duckdb/spool";
import { DbError } from "@ax/lib/errors";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    INGEST_RUN_HEARTBEAT_EVERY_FILES,
    INGEST_SPOOL_TABLES,
    runJsonlProviderFiles,
    shouldHeartbeatIngestRun,
} from "./jsonl-work-unit.ts";
import type { JsonlFileCandidate } from "./walk-jsonl.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("JSONL work unit", { requireFts: true });
const candidate = (path: string, mtimeMs: number, sizeBytes = 100): JsonlFileCandidate => ({ path, mtimeMs, sizeBytes });

const options = (candidates: readonly JsonlFileCandidate[], processed: string[], failPath?: string) => ({
    candidates,
    sourceKind: "codex_session",
    forceEnv: "AX_REDERIVE_TEST",
    source: "codex",
    processFile: (item: JsonlFileCandidate) => item.path === failPath
        ? Effect.fail(new DbError({ operation: "query", message: "boom" }))
        : Effect.sync(() => {
            processed.push(item.path);
            return true;
        }),
});

describe("runJsonlProviderFiles on real DuckDB", () => {
    dtest("skips unchanged files and processes one changed file", async () => {
        const first: string[] = [];
        const second: string[] = [];
        let firstResult: unknown;
        let secondResult: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-skip-"), dylibPath, (write) =>
            Effect.gen(function* () {
                firstResult = yield* runJsonlProviderFiles(write, options([
                    candidate("a.jsonl", 10), candidate("b.jsonl", 20),
                ], first));
                secondResult = yield* runJsonlProviderFiles(write, options([
                    candidate("a.jsonl", 10), candidate("b.jsonl", 25, 200),
                ], second));
            }),
        ));
        expect(firstResult).toMatchObject({ files: 2, skippedUnchanged: 0 });
        expect(secondResult).toMatchObject({ files: 1, skippedUnchanged: 1 });
        expect(first).toEqual(["a.jsonl", "b.jsonl"]);
        expect(second).toEqual(["b.jsonl"]);
    });

    dtest("retries an isolated failure and does not mark a vanished file", async () => {
        const first: string[] = [];
        const second: string[] = [];
        let failed: unknown;
        let retried: unknown;
        let marks = -1;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-retry-"), dylibPath, (write) =>
            Effect.gen(function* () {
                failed = yield* runJsonlProviderFiles(write, options([
                    candidate("ok.jsonl", 10), candidate("bad.jsonl", 20),
                ], first, "bad.jsonl"));
                yield* runJsonlProviderFiles(write, {
                    ...options([candidate("gone.jsonl", 30)], []),
                    processFile: () => Effect.succeed(false),
                });
                retried = yield* runJsonlProviderFiles(write, options([
                    candidate("ok.jsonl", 10), candidate("bad.jsonl", 20),
                ], second));
                marks = (yield* write.rows(Schema.Struct({ count: Schema.Number }),
                    "SELECT count(*)::INTEGER AS count FROM ingest_file_state"))[0]!.count;
            }),
        ));
        expect(failed).toMatchObject({ files: 1, skippedUnchanged: 0 });
        expect((failed as { failures: { count(): number } }).failures.count()).toBe(1);
        expect(retried).toMatchObject({ files: 1, skippedUnchanged: 1 });
        expect(first).toEqual(["ok.jsonl"]);
        expect(second).toEqual(["bad.jsonl"]);
        expect(marks).toBe(2);
    });

    dtest("the force variable processes an unchanged file again", async () => {
        const processed: string[] = [];
        let forced: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-force-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* runJsonlProviderFiles(write, options([candidate("a.jsonl", 10)], processed));
                process.env.AX_REDERIVE_TEST = "1";
                try {
                    forced = yield* runJsonlProviderFiles(write, options([candidate("a.jsonl", 10)], processed));
                } finally {
                    delete process.env.AX_REDERIVE_TEST;
                }
            }),
        ));
        expect(forced).toMatchObject({ files: 1, skippedUnchanged: 0 });
        expect(processed).toEqual(["a.jsonl", "a.jsonl"]);
    });
});

describe("spool mode", () => {
    test("INGEST_SPOOL_TABLES: every member is in the DDL; the survey's exclusions are not members", () => {
        for (const table of INGEST_SPOOL_TABLES) {
            expect(parseDuckdbColumnDefs(table).length).toBeGreaterThan(0);
        }
        // The #886 read-back survey verdicts. Adding one of these to the spool
        // set silently breaks a same-run read-back or a keyed-DELETE ordering;
        // see the INGEST_SPOOL_TABLES doc for which one.
        for (const excluded of ["session", "skill", "skill_revision", "plan", "plan_item", "ingest_file_state"]) {
            expect(INGEST_SPOOL_TABLES).not.toContain(excluded);
        }
    });

    dtest("rows land and watermarks are DEFERRED to the flush; a failed file never marks", async () => {
        const dir = tempDir("ax-jsonl-spool-");
        let rowsAfter = -1;
        let marksAfter = -1;
        let markPaths: string[] = [];
        await runWithPlatform(publishCacheFixture(dir, dylibPath, (write) =>
            Effect.gen(function* () {
                const spool = makeTableSpool({ tables: ["tool"], dir: `${dir}/spool` });
                const spooled = withTableSpool(write, spool);
                const result = yield* runJsonlProviderFiles(spooled, {
                    candidates: [candidate("a.jsonl", 10), candidate("bad.jsonl", 20), candidate("b.jsonl", 30)],
                    sourceKind: "codex_session",
                    forceEnv: "AX_REDERIVE_TEST",
                    source: "codex",
                    spool,
                    processFile: (item): Effect.Effect<boolean, DbError | CacheWriteError> =>
                        item.path === "bad.jsonl"
                            ? Effect.fail(new DbError({ operation: "query", message: "boom" }))
                            : spooled.put("tool", { id: `tool:${item.path}`, name: item.path }).pipe(Effect.as(true)),
                });
                expect(result.files).toBe(2);
                // The loop is over, so the final flush ran: rows AND marks
                // are visible together.
                const rows = yield* write.rows(
                    Schema.Struct({ count: Schema.Number }),
                    "SELECT count(*)::INTEGER AS count FROM tool",
                );
                rowsAfter = rows[0]!.count;
                const marks = yield* write.rows(
                    Schema.Struct({ path: Schema.String }),
                    "SELECT path FROM ingest_file_state ORDER BY path",
                );
                marksAfter = marks.length;
                markPaths = marks.map((m) => m.path);
            }),
        ));
        expect(rowsAfter).toBe(2);
        expect(marksAfter).toBe(2);
        expect(markPaths).toEqual(["a.jsonl", "b.jsonl"]);
    });

    dtest("a second run skips the files the deferred marks covered", async () => {
        const dir = tempDir("ax-jsonl-spool-skip-");
        let second: unknown;
        await runWithPlatform(publishCacheFixture(dir, dylibPath, (write) =>
            Effect.gen(function* () {
                const run = (processed: string[]) =>
                    Effect.gen(function* () {
                        const spool = makeTableSpool({ tables: ["tool"], dir: `${dir}/spool` });
                        const spooled = withTableSpool(write, spool);
                        return yield* runJsonlProviderFiles(spooled, {
                            candidates: [candidate("a.jsonl", 10), candidate("b.jsonl", 20)],
                            sourceKind: "codex_session",
                            forceEnv: "AX_REDERIVE_TEST",
                            source: "codex",
                            spool,
                            processFile: (item) =>
                                spooled
                                    .put("tool", { id: `tool:${item.path}`, name: item.path })
                                    .pipe(Effect.as(true), Effect.tap(() => Effect.sync(() => processed.push(item.path)))),
                        });
                    });
                yield* run([]);
                const processedSecond: string[] = [];
                second = yield* run(processedSecond);
                expect(processedSecond).toEqual([]);
            }),
        ));
        expect(second).toMatchObject({ files: 0, skippedUnchanged: 2 });
    });
});

describe("JSONL provider heartbeat", () => {
    test("uses a 25-file interval", () => {
        expect(INGEST_RUN_HEARTBEAT_EVERY_FILES).toBe(25);
        expect(shouldHeartbeatIngestRun(24)).toBe(false);
        expect(shouldHeartbeatIngestRun(25)).toBe(true);
        expect(shouldHeartbeatIngestRun(50)).toBe(true);
    });

    dtest("updates a real parent run after 25 files", async () => {
        let progressAt: Date | null = null;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-heartbeat-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("ingest_run", {
                    id: "live-run", command: "ingest", started_at: new Date("2026-01-01T00:00:00Z"),
                });
                yield* runJsonlProviderFiles(write, {
                    ...options(Array.from({ length: 25 }, (_, index) => candidate(`${index}.jsonl`, index + 1)), []),
                    runId: "live-run",
                });
                progressAt = (yield* write.rows(Schema.Struct({ value: Schema.NullOr(Schema.Date) }),
                    "SELECT last_progress_at AS value FROM ingest_run WHERE id = ?", ["live-run"]))[0]!.value;
            }),
        ));
        expect(progressAt).toBeInstanceOf(Date);
    });
});

describe("content-hash tier (#900) on real files", () => {
    const statOf = async (path: string) => {
        const stat = await Bun.file(path).stat();
        return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
    };

    dtest("a touched-but-identical file refreshes its mark and skips the parse", async () => {
        const dir = tempDir("ax-jsonl-content-");
        const filePath = `${dir}/one.jsonl`;
        await Bun.write(filePath, `{"kind":"row"}\n`);
        const statA = await statOf(filePath);
        // A touch moves the stats while the bytes stay the same. Model it by
        // MOVING THE CANDIDATE STATS, not by rewriting the file: back-to-back
        // writes can land inside one timer tick (they did on Linux CI), and
        // identical stats make the FAST tier skip before the durable tier runs.
        const statB = { mtimeMs: statA.mtimeMs + 7, sizeBytes: statA.sizeBytes };

        const first: string[] = [];
        const second: string[] = [];
        let firstResult: unknown;
        let secondResult: unknown;
        let storedSha: string | null = null;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-content-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                firstResult = yield* runJsonlProviderFiles(write, {
                    ...options([candidate(filePath, statA.mtimeMs, statA.sizeBytes)], first),
                    contentHash: true,
                });
                secondResult = yield* runJsonlProviderFiles(write, {
                    ...options([candidate(filePath, statB.mtimeMs, statB.sizeBytes)], second),
                    contentHash: true,
                });
                storedSha = (yield* write.rows(Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
                    "SELECT sha FROM ingest_file_state WHERE path = ?", [filePath]))[0]!.sha;
            }),
        ));
        expect(firstResult).toMatchObject({ files: 1, skippedUnchanged: 0, refreshedUnchanged: 0 });
        // The refresh: no parse (processFile never ran), the mark advanced.
        expect(secondResult).toMatchObject({ files: 0, skippedUnchanged: 0, refreshedUnchanged: 1 });
        expect(first).toEqual([filePath]);
        expect(second).toEqual([]);
        // Verify by transformation: the stored sha IS the file's SHA-256.
        const expected = await Effect.runPromise(hashFileSha256(filePath));
        expect(storedSha as string | null).toBe(expected);
    });

    dtest("changed content parses and stamps the fresh sha; third run fast-skips", async () => {
        const dir = tempDir("ax-jsonl-content2-");
        const filePath = `${dir}/two.jsonl`;
        await Bun.write(filePath, `{"v":1}\n`);
        const statA = await statOf(filePath);

        const runs: string[][] = [[], [], []];
        const results: unknown[] = [];
        let storedSha: string | null = null;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-content2-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                results[0] = yield* runJsonlProviderFiles(write, {
                    ...options([candidate(filePath, statA.mtimeMs, statA.sizeBytes)], runs[0]!),
                    contentHash: true,
                });
                // Change the CONTENT between runs, so run 2 hashes new bytes.
                // Candidate mtime is bumped past run 1's mark by hand: the
                // rewrite can land inside run 1's timer tick (same size, same
                // mtime), and then the fast tier would skip run 2 entirely.
                const statB = yield* Effect.promise(async () => {
                    await Bun.write(filePath, `{"v":2}\n`);
                    const stat = await statOf(filePath);
                    return { mtimeMs: Math.max(stat.mtimeMs, statA.mtimeMs + 7), sizeBytes: stat.sizeBytes };
                });
                for (const index of [1, 2]) {
                    results[index] = yield* runJsonlProviderFiles(write, {
                        ...options([candidate(filePath, statB.mtimeMs, statB.sizeBytes)], runs[index]!),
                        contentHash: true,
                    });
                }
                storedSha = (yield* write.rows(Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
                    "SELECT sha FROM ingest_file_state WHERE path = ?", [filePath]))[0]!.sha;
            }),
        ));
        expect(results[0]).toMatchObject({ files: 1, refreshedUnchanged: 0 });
        // Genuinely changed: parsed, not refreshed.
        expect(results[1]).toMatchObject({ files: 1, skippedUnchanged: 0, refreshedUnchanged: 0 });
        // Unchanged stats: the FAST tier skips - no read, no hash.
        expect(results[2]).toMatchObject({ files: 0, skippedUnchanged: 1, refreshedUnchanged: 0 });
        expect(runs[1]).toEqual([filePath]);
        expect(runs[2]).toEqual([]);
        const expected = await Effect.runPromise(hashFileSha256(filePath));
        expect(storedSha as string | null).toBe(expected);
    });

    dtest("a NEW path with bytes matching an ordinary file mark still parses", async () => {
        const dir = tempDir("ax-jsonl-content-copy-");
        const firstPath = `${dir}/session-a.jsonl`;
        const secondPath = `${dir}/session-b.jsonl`;
        const bytes = `{"kind":"same-bytes"}\n`;
        await Bun.write(firstPath, bytes);
        await Bun.write(secondPath, bytes);
        const firstStat = await statOf(firstPath);
        const secondStat = await statOf(secondPath);

        const first: string[] = [];
        const second: string[] = [];
        let firstResult: unknown;
        let secondResult: unknown;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-content-copy-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                firstResult = yield* runJsonlProviderFiles(write, {
                    ...options([candidate(firstPath, firstStat.mtimeMs, firstStat.sizeBytes)], first),
                    contentHash: true,
                });
                secondResult = yield* runJsonlProviderFiles(write, {
                    ...options([candidate(secondPath, secondStat.mtimeMs, secondStat.sizeBytes)], second),
                    contentHash: true,
                });
            }),
        ));

        expect(firstResult).toMatchObject({ files: 1, refreshedUnchanged: 0 });
        expect(secondResult).toMatchObject({ files: 1, skippedUnchanged: 0, refreshedUnchanged: 0 });
        expect(first).toEqual([firstPath]);
        expect(second).toEqual([secondPath]);
    });

    dtest("an __imported__ sentinel mark makes a NEW path with those bytes refresh-skip; force still parses", async () => {
        const dir = tempDir("ax-jsonl-content3-");
        const filePath = `${dir}/imported.jsonl`;
        await Bun.write(filePath, `{"seg":"row"}\n`);
        const stat = await statOf(filePath);
        const sha = (await Effect.runPromise(hashFileSha256(filePath))) as string;

        const first: string[] = [];
        const forced: string[] = [];
        let firstResult: unknown;
        let forcedResult: unknown;
        let newPathSha: string | null = null;
        await runWithPlatform(publishCacheFixture(tempDir("ax-jsonl-content3-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                // What `ax segment import` will write: a sentinel mark keyed by
                // content, attesting the bytes are already in the store.
                yield* write.put(WATERMARK_TABLE, watermarkRow("codex_session", importedMarkPath("codex_session", sha), { sha }));
                firstResult = yield* runJsonlProviderFiles(write, {
                    ...options([candidate(filePath, stat.mtimeMs, stat.sizeBytes)], first),
                    contentHash: true,
                });
                newPathSha = (yield* write.rows(Schema.Struct({ sha: Schema.NullOr(Schema.String) }),
                    "SELECT sha FROM ingest_file_state WHERE path = ?", [filePath]))[0]!.sha;
                // A forced run must ignore the handshake and parse for real.
                process.env["AX_REDERIVE_TEST"] = "1";
                forcedResult = yield* runJsonlProviderFiles(write, {
                    ...options([candidate(filePath, stat.mtimeMs, stat.sizeBytes)], forced),
                    contentHash: true,
                }).pipe(Effect.ensuring(Effect.sync(() => { delete process.env["AX_REDERIVE_TEST"]; })));
            }),
        ));
        // Never parsed: the sentinel's sha vouched for the bytes.
        expect(firstResult).toMatchObject({ files: 0, skippedUnchanged: 0, refreshedUnchanged: 1 });
        expect(first).toEqual([]);
        // And the NEW path got its own full mark, so the next run fast-skips.
        expect(newPathSha as string | null).toBe(sha);
        expect(forcedResult).toMatchObject({ files: 1, refreshedUnchanged: 0 });
        expect(forced).toEqual([filePath]);
    });
});
