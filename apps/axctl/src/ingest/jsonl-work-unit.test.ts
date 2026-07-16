import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { DbError } from "@ax/lib/errors";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import {
    INGEST_RUN_HEARTBEAT_EVERY_FILES,
    runJsonlProviderFiles,
    shouldHeartbeatIngestRun,
} from "./jsonl-work-unit.ts";
import type { JsonlFileCandidate } from "./walk-jsonl.ts";

/** A stateful fake of the `ingest_file_state` watermark table: the SELECT
 *  returns whatever prior commits stored, and the UPSERT records them - so a
 *  second run sees the marks a first run wrote (the whole point of the skip). */
function statefulWatermarkLayer() {
    const store = new Map<string, { path: string; mtime_ms: number; size: number }>();
    const tc = makeTestSurrealClient({
        fallback: (sql) => {
            if (sql.includes("__watermark_migration__")) return [[]];
            if (sql.includes("UPSERT ingest_file_state")) {
                const path = /path: "([^"]*)"/.exec(sql)?.[1];
                const mtime = Number(/mtime_ms: (-?\d+)/.exec(sql)?.[1] ?? "0");
                const size = Number(/size: (-?\d+)/.exec(sql)?.[1] ?? "0");
                if (path) store.set(path, { path, mtime_ms: mtime, size });
                return [[]];
            }
            if (sql.includes("FROM ingest_file_state")) {
                return [Array.from(store.values())];
            }
            return [[]];
        },
    });
    return { layer: tc.layer, store, tc };
}

const candidate = (path: string, mtimeMs: number, sizeBytes = 100): JsonlFileCandidate => ({ path, mtimeMs, sizeBytes });

describe("runJsonlProviderFiles - skip-unchanged watermark", () => {
    test("first run processes all; identical second run skips all", async () => {
        const { layer, store } = statefulWatermarkLayer();
        const candidates = [candidate("a.jsonl", 10), candidate("b.jsonl", 20), candidate("c.jsonl", 30)];

        const run = (processed: string[]) =>
            runJsonlProviderFiles({
                candidates,
                sourceKind: "codex_session",
                forceEnv: "AX_REDERIVE_TEST",
                source: "codex",
                processFile: (c) => Effect.sync(() => {
                    processed.push(c.path);
                    return true;
                }),
            }).pipe(Effect.provide(layer));

        const first: string[] = [];
        const r1 = await Effect.runPromise(run(first));
        expect(r1.files).toBe(3);
        expect(r1.skippedUnchanged).toBe(0);
        expect(first.sort()).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
        expect(store.size).toBe(3);

        const second: string[] = [];
        const r2 = await Effect.runPromise(run(second));
        expect(r2.files).toBe(0);
        expect(r2.skippedUnchanged).toBe(3);
        expect(second).toEqual([]); // nothing re-parsed
    });

    test("a changed (mtime,size) re-processes only that file", async () => {
        const { layer } = statefulWatermarkLayer();
        const processFile = (processed: string[]) => (c: JsonlFileCandidate) =>
            Effect.sync(() => {
                processed.push(c.path);
                return true;
            });

        const base = [candidate("a.jsonl", 10), candidate("b.jsonl", 20)];
        const first: string[] = [];
        await Effect.runPromise(
            runJsonlProviderFiles({ candidates: base, sourceKind: "codex_session", forceEnv: "AX_REDERIVE_TEST", source: "codex", processFile: processFile(first) })
                .pipe(Effect.provide(layer)),
        );
        expect(first.length).toBe(2);

        // b.jsonl grows (new mtime + size); a.jsonl unchanged.
        const changed = [candidate("a.jsonl", 10), candidate("b.jsonl", 25, 200)];
        const second: string[] = [];
        const r = await Effect.runPromise(
            runJsonlProviderFiles({ candidates: changed, sourceKind: "codex_session", forceEnv: "AX_REDERIVE_TEST", source: "codex", processFile: processFile(second) })
                .pipe(Effect.provide(layer)),
        );
        expect(r.files).toBe(1);
        expect(r.skippedUnchanged).toBe(1);
        expect(second).toEqual(["b.jsonl"]);
    });

    test("an isolated failure does not commit the watermark - file retries next run", async () => {
        const { layer } = statefulWatermarkLayer();
        const candidates = [candidate("ok.jsonl", 10), candidate("bad.jsonl", 20)];

        const run = (failBad: boolean, processed: string[]) =>
            runJsonlProviderFiles({
                candidates,
                sourceKind: "codex_session",
                forceEnv: "AX_REDERIVE_TEST",
                source: "codex",
                processFile: (c) =>
                    failBad && c.path === "bad.jsonl"
                        ? Effect.fail(new DbError({ operation: "query", message: "boom" }))
                        : Effect.sync(() => {
                            processed.push(c.path);
                            return true;
                        }),
            }).pipe(Effect.provide(layer));

        const first: string[] = [];
        const r1 = await Effect.runPromise(run(true, first));
        expect(r1.files).toBe(1); // only ok.jsonl committed
        expect(r1.failures.count()).toBe(1);
        expect(first).toEqual(["ok.jsonl"]);

        // Next run, nothing fails: ok.jsonl is skipped (committed), bad.jsonl retries.
        const second: string[] = [];
        const r2 = await Effect.runPromise(run(false, second));
        expect(r2.skippedUnchanged).toBe(1);
        expect(r2.files).toBe(1);
        expect(second).toEqual(["bad.jsonl"]);
    });

    test("a vanished file (processFile returns null) neither counts nor commits", async () => {
        const { layer, store } = statefulWatermarkLayer();
        const candidates = [candidate("gone.jsonl", 10)];
        const r = await Effect.runPromise(
            runJsonlProviderFiles({
                candidates,
                sourceKind: "codex_session",
                forceEnv: "AX_REDERIVE_TEST",
                source: "codex",
                processFile: () => Effect.succeed(false),
            }).pipe(Effect.provide(layer)),
        );
        expect(r.files).toBe(0);
        expect(store.size).toBe(0); // never marked done
    });

    test("AX_REDERIVE_* forces reprocessing even when marks exist", async () => {
        const { layer } = statefulWatermarkLayer();
        const candidates = [candidate("a.jsonl", 10)];
        const opts = (processed: string[]) => ({
            candidates,
            sourceKind: "codex_session",
            forceEnv: "AX_REDERIVE_TEST",
            source: "codex",
            processFile: (c: JsonlFileCandidate) => Effect.sync(() => {
                processed.push(c.path);
                return true;
            }),
        });
        const first: string[] = [];
        await Effect.runPromise(runJsonlProviderFiles(opts(first)).pipe(Effect.provide(layer)));
        expect(first).toEqual(["a.jsonl"]);

        process.env.AX_REDERIVE_TEST = "1";
        try {
            const second: string[] = [];
            const r = await Effect.runPromise(runJsonlProviderFiles(opts(second)).pipe(Effect.provide(layer)));
            expect(r.files).toBe(1); // forced re-derive ignores the mark
            expect(second).toEqual(["a.jsonl"]);
        } finally {
            delete process.env.AX_REDERIVE_TEST;
        }
    });
});

describe("JSONL provider ingest_run heartbeat", () => {
    test("throttles to every 25 successfully completed files", () => {
        expect(INGEST_RUN_HEARTBEAT_EVERY_FILES).toBe(25);
        expect(shouldHeartbeatIngestRun(0)).toBe(false);
        expect(shouldHeartbeatIngestRun(1)).toBe(false);
        expect(shouldHeartbeatIngestRun(24)).toBe(false);
        expect(shouldHeartbeatIngestRun(25)).toBe(true);
        expect(shouldHeartbeatIngestRun(26)).toBe(false);
        expect(shouldHeartbeatIngestRun(50)).toBe(true);
    });

    test("emits one best-effort parent run heartbeat after 25 files", async () => {
        const { layer, tc } = statefulWatermarkLayer();
        const candidates = Array.from(
            { length: INGEST_RUN_HEARTBEAT_EVERY_FILES },
            (_, index) => candidate(`${index}.jsonl`, index + 1),
        );

        const result = await Effect.runPromise(
            runJsonlProviderFiles({
                candidates,
                sourceKind: "codex_session",
                forceEnv: "AX_REDERIVE_TEST",
                source: "codex",
                runId: "live-run",
                processFile: () => Effect.succeed(true),
            }).pipe(Effect.provide(layer)),
        );

        expect(result.files).toBe(25);
        const heartbeats = tc.captured.filter((sql) =>
            sql.includes("UPDATE ingest_run:`live-run` SET last_progress_at = time::now()")
        );
        expect(heartbeats).toEqual([
            "UPDATE ingest_run:`live-run` SET last_progress_at = time::now() RETURN NONE;",
        ]);
    });
});
