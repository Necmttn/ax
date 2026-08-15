import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DbError } from "@ax/lib/errors";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import {
    INGEST_RUN_HEARTBEAT_EVERY_FILES,
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
