import { describe, expect, it } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { DbError } from "@ax/lib/errors";
import { ProcessServiceLive } from "@ax/lib/process";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { LiveTraceLayer } from "@ax/lib/live-traces/Tracer";
import { TraceSinkLive, TraceTransportTag, type TraceTransport } from "@ax/lib/live-traces/Sink";
import { CacheRead, CacheReadLayer } from "@ax/lib/duckdb";
import { StageRegistryLive, type IngestStageError, type StageDef } from "./stage/registry.ts";
import { BaseStageStats, StageMeta } from "./stage/types.ts";
import { runIngest, stageEventName, withIngestRunFinish } from "./run.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ingest run", { requireFts: true });

const stage = (key: string, deps: string[] = [], delay = 0): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: [key === "outcomes" ? "derive" : "ingest"], writes: [] }),
    run: () => Effect.succeed({
        ...BaseStageStats.make({ durationMs: 1, summary: `${key} done` }),
        sessions: key === "skills" ? 3 : 0,
    }).pipe(delay > 0 ? Effect.delay(`${delay} millis`) : (effect) => effect),
});

const traceLayer = () => {
    const transport: TraceTransport = { send: () => Effect.void };
    const sink = TraceSinkLive({ flushIntervalMs: 1 }).pipe(
        Layer.provide(Layer.succeed(TraceTransportTag, transport)),
    );
    return Layer.mergeAll(sink, LiveTraceLayer.pipe(Layer.provide(sink)));
};

/** Run `runIngest` fully wired (registry + config + trace layers), against
 *  whichever live/snapshot paths the caller pinned via env. */
const runIngestOnce = (
    dataDir: string,
    stages: ReadonlyArray<StageDef<BaseStageStats, never, IngestStageError>>,
    runId: string,
) =>
    withIngestLock({
        lockPath: `${dataDir}/ingest.lock`,
        command: "test ingest",
        staleMs: 60_000,
        onBusy: () => Effect.die("test ingest lock is busy"),
    }, runIngest({
        command: "ingest",
        args: [],
        cwd: "/tmp/ax",
        now: () => new Date("2026-05-29T00:00:00Z"),
        runId: () => runId,
    })).pipe(Effect.provide(Layer.mergeAll(
        StageRegistryLive(stages),
        traceLayer(),
        AxConfigTest({ paths: { dataDir } }).pipe(
            Layer.provide(BunFileSystem.layer),
        ),
        ProcessServiceLive,
        BunFileSystem.layer,
        BunPath.layer,
    )));

describe("stageEventName", () => {
    it("uses canonical and fallback labels", () => {
        expect(stageEventName("skills")).toEqual({ source: "skills", stage: "upsert" });
        expect(stageEventName("turn-analysis")).toEqual({ source: "turn-analysis", stage: "derive" });
        expect(stageEventName("unknown-provider")).toEqual({ source: "unknown-provider", stage: "run" });
    });
});

describe("withIngestRunFinish on real DuckDB", () => {
    dtest("records success and typed failure states", async () => {
        class BoomError extends Schema.TaggedErrorClass<BoomError>("BoomError")("BoomError", {
            message: Schema.String,
        }) {}
        let rows: readonly unknown[] = [];
        let failed = false;
        await runWithPlatform(publishCacheFixture(tempDir("ax-run-finish-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("ingest_run", [
                    { id: "ok", command: "ingest" },
                    { id: "error", command: "ingest" },
                ]);
                yield* withIngestRunFinish(write, "ok")(Effect.succeed("done"));
                failed = Exit.isFailure(yield* Effect.exit(
                    withIngestRunFinish(write, "error")(Effect.fail(new BoomError({ message: "boom" }))),
                ));
                rows = yield* write.rows(Schema.Struct({ id: Schema.String, status: Schema.String, metrics: Schema.String }),
                    "SELECT id, status, metrics FROM ingest_run ORDER BY id");
            }),
        ));
        expect(failed).toBe(true);
        expect(rows).toEqual([
            { id: "error", status: "error", metrics: '{"error":"boom"}' },
            { id: "ok", status: "ok", metrics: "{}" },
        ]);
    });

    dtest("records an interrupted run as partial", async () => {
        let status = "";
        await runWithPlatform(publishCacheFixture(tempDir("ax-run-interrupt-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.put("ingest_run", { id: "partial", command: "ingest" });
                yield* Effect.promise(async () => {
                    const fiber = Effect.runFork(withIngestRunFinish(write, "partial")(Effect.never));
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    await Effect.runPromise(Fiber.interrupt(fiber));
                });
                status = (yield* write.rows(Schema.Struct({ status: Schema.String }),
                    "SELECT status FROM ingest_run WHERE id = ?", ["partial"]))[0]!.status;
            }),
        ));
        expect(status).toBe("partial");
    });
});

describe("runIngest on real DuckDB", () => {
    dtest("writes run and stage rows, totals, and an uncapped derive stage", async () => {
        if (dylibPath === null) return;
        const previous = process.env.AX_DUCKDB_DYLIB;
        process.env.AX_DUCKDB_DYLIB = dylibPath;
        const dataDir = tempDir("ax-run-live-");
        const started = Date.now();
        try {
            const result = await Effect.runPromise(withIngestLock({
                lockPath: `${dataDir}/ingest.lock`,
                command: "test ingest",
                staleMs: 60_000,
                onBusy: () => Effect.die("test ingest lock is busy"),
            }, runIngest({
                command: "ingest",
                args: [],
                cwd: "/tmp/ax",
                now: () => new Date("2026-05-29T00:00:00Z"),
                runId: () => "test_run",
            })).pipe(Effect.provide(Layer.mergeAll(
                StageRegistryLive([stage("skills"), stage("outcomes", ["skills"], 80)]),
                traceLayer(),
                AxConfigTest({ paths: { dataDir }, knobs: { ingestTimeoutSeconds: 0.05 } }).pipe(
                    Layer.provide(BunFileSystem.layer),
                ),
                ProcessServiceLive,
                BunFileSystem.layer,
                BunPath.layer,
            ))));
            expect(result).toMatchObject({
                _tag: "completed",
                value: {
                    runId: "test_run",
                    selectedStages: ["skills", "outcomes"],
                    status: "ok",
                    totals: { sessions: 3 },
                },
            });
            expect(Date.now() - started).toBeGreaterThanOrEqual(75);
        } finally {
            if (previous === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = previous;
        }
    });

    dtest("rejects reset with stage filters before graph deletion", async () => {
        if (dylibPath === null) return;
        const previous = process.env.AX_DUCKDB_DYLIB;
        process.env.AX_DUCKDB_DYLIB = dylibPath;
        try {
            const dataDir = tempDir("ax-run-reset-");
            const exit = await Effect.runPromiseExit(withIngestLock({
                lockPath: `${dataDir}/ingest.lock`,
                command: "test reset",
                staleMs: 60_000,
                onBusy: () => Effect.die("test ingest lock is busy"),
            }, runIngest({
                command: "ingest",
                args: ["--reset", "--stages=skills"],
                cwd: "/tmp/ax",
                runId: () => "reset_run",
            })).pipe(Effect.provide(Layer.mergeAll(
                StageRegistryLive([stage("skills")]),
                traceLayer(),
                AxConfigTest({ paths: { dataDir } }).pipe(
                    Layer.provide(BunFileSystem.layer),
                ),
                ProcessServiceLive,
                BunFileSystem.layer,
                BunPath.layer,
            ))));
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("--reset rebuilds the whole skill graph");
        } finally {
            if (previous === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = previous;
        }
    });
});

describe("runIngest cold-start intermediate publish (#833)", () => {
    /** A first-value provider stage - what claude/codex/pi/omp/opencode/cursor
     *  carry in production (see registry.test.ts's "marks exactly the six..."). */
    const firstValueStage = (
        key: string,
        deps: string[] = [],
    ): StageDef<BaseStageStats, never, IngestStageError> => ({
        meta: StageMeta.make({ key, deps, tags: ["ingest"], writes: [], firstValue: true }),
        run: (_ctx, write) => Effect.gen(function* () {
            const sessionId = `${key}_session`;
            yield* write.put("session", { id: sessionId, source: key });
            yield* write.put("turn", {
                id: `${sessionId}_turn`,
                session: sessionId,
                seq: 1,
                ts: new Date("2026-05-29T00:00:00Z"),
                role: "user",
                text: "first value",
            });
            return BaseStageStats.make({ durationMs: 0, summary: `${key} done` });
        }),
    });

    /** A stage that never carries `firstValue` - lands in the remainder phase
     *  on a cold run. Signals `started` the instant its body begins (BEFORE
     *  it does anything else), then blocks on `gate` - so awaiting `started`
     *  is a deterministic proof that everything sequenced before it in
     *  `runIngest` (the whole first-value phase, its FTS build, and its
     *  intermediate publish) has already been awaited to completion. No
     *  timing/sleep assertions anywhere in this suite. */
    const blockedRemainderStage = (
        key: string,
        started: Deferred.Deferred<void>,
        gate: Deferred.Deferred<void>,
    ): StageDef<BaseStageStats, never, IngestStageError> => ({
        meta: StageMeta.make({ key, deps: [], tags: ["ingest"], writes: [] }),
        run: () => Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            return BaseStageStats.make({ durationMs: 0, summary: `${key} done` });
        }),
    });

    /** Pin AX_DUCKDB_DYLIB + AX_DUCKDB_SNAPSHOT for the duration of `body`,
     *  restoring both afterwards - `runIngest` never overrides `snapshotPath`
     *  itself, so this is how a test controls where it publishes. */
    const withPinnedEnv = async <A>(dataDir: string, body: (snapshotPath: string) => Promise<A>): Promise<A> => {
        const previousDylib = process.env.AX_DUCKDB_DYLIB;
        const previousSnapshot = process.env.AX_DUCKDB_SNAPSHOT;
        const snapshotPath = `${dataDir}/ax-snapshot.duckdb`;
        if (dylibPath !== null) process.env.AX_DUCKDB_DYLIB = dylibPath;
        process.env.AX_DUCKDB_SNAPSHOT = snapshotPath;
        try {
            return await body(snapshotPath);
        } finally {
            if (previousDylib === undefined) delete process.env.AX_DUCKDB_DYLIB;
            else process.env.AX_DUCKDB_DYLIB = previousDylib;
            if (previousSnapshot === undefined) delete process.env.AX_DUCKDB_SNAPSHOT;
            else process.env.AX_DUCKDB_SNAPSHOT = previousSnapshot;
        }
    };

    dtest("cold start: publishes before a blocked remainder stage finishes, then still publishes the final snapshot", async () => {
        if (dylibPath === null) return;
        const dataDir = tempDir("ax-run-cold-intermediate-");
        await withPinnedEnv(dataDir, async (snapshotPath) => {
            expect(existsSync(snapshotPath)).toBe(false); // genuinely cold

            const { started, gate } = await Effect.runPromise(Effect.gen(function* () {
                return { started: yield* Deferred.make<void>(), gate: yield* Deferred.make<void>() };
            }));
            const stages: Array<StageDef<BaseStageStats, never, IngestStageError>> = [
                stage("skills"),
                firstValueStage("claude", ["skills"]),
                blockedRemainderStage("remainder", started, gate),
            ];

            const fiber = Effect.runFork(runIngestOnce(dataDir, stages, "cold_run"));

            // Deterministic: the remainder stage can only have STARTED after
            // runIngest sequentially awaited the whole first-value phase, its
            // TURN-only FTS build, and the intermediate publish - see the
            // comment on `blockedRemainderStage`.
            await Effect.runPromise(Deferred.await(started));
            expect(existsSync(snapshotPath)).toBe(true);

            // The intermediate snapshot is a real, readable publish - not a
            // half-written file.
            const midRunRows = await Effect.runPromise(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.raw(
                        "SELECT r.id, r.status, count(DISTINCT s.id) AS sessions, " +
                            "count(DISTINCT t.id) AS turns " +
                            "FROM ingest_run r, session s, turn t " +
                            "WHERE r.id = 'cold_run' GROUP BY r.id, r.status",
                    );
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath }))),
            );
            expect(midRunRows).toMatchObject({
                rows: [{ id: "cold_run", status: "running", sessions: 1n, turns: 1n }],
            });

            await Effect.runPromise(Deferred.succeed(gate, undefined));
            const result = await Effect.runPromise(Fiber.join(fiber));
            expect(result).toMatchObject({ _tag: "completed", value: { runId: "cold_run", status: "ok" } });

            // The final publish still occurs on success, reflecting the
            // completed run.
            const finalRows = await Effect.runPromise(
                Effect.gen(function* () {
                    const read = yield* CacheRead;
                    return yield* read.raw("SELECT id, status FROM ingest_run WHERE id = 'cold_run'");
                }).pipe(Effect.provide(CacheReadLayer({ snapshotPath }))),
            );
            expect(finalRows).toMatchObject({ rows: [{ id: "cold_run", status: "ok" }] });
        });
    });

    dtest("warm start: an already-published snapshot is not intermediately replaced", async () => {
        if (dylibPath === null) return;
        const dataDir = tempDir("ax-run-warm-no-intermediate-");
        await withPinnedEnv(dataDir, async (snapshotPath) => {
            // Seed a real published snapshot first.
            await Effect.runPromise(runIngestOnce(dataDir, [stage("skills")], "warm_seed"));
            expect(existsSync(snapshotPath)).toBe(true);
            const beforeSecondRun = readFileSync(snapshotPath);

            const { started, gate } = await Effect.runPromise(Effect.gen(function* () {
                return { started: yield* Deferred.make<void>(), gate: yield* Deferred.make<void>() };
            }));
            const stages: Array<StageDef<BaseStageStats, never, IngestStageError>> = [
                stage("skills"),
                firstValueStage("claude", ["skills"]),
                blockedRemainderStage("remainder", started, gate),
            ];

            const fiber = Effect.runFork(runIngestOnce(dataDir, stages, "warm_run"));
            await Effect.runPromise(Deferred.await(started));

            // No intermediate publish on a warm start: byte-identical while
            // the remainder stage is still blocked.
            expect(readFileSync(snapshotPath).equals(beforeSecondRun)).toBe(true);

            await Effect.runPromise(Deferred.succeed(gate, undefined));
            await Effect.runPromise(Fiber.join(fiber));

            // The final publish still happens once the whole run completes.
            expect(readFileSync(snapshotPath).equals(beforeSecondRun)).toBe(false);
        });
    });

    dtest("cold start: a failed first-value phase never publishes", async () => {
        if (dylibPath === null) return;
        const dataDir = tempDir("ax-run-cold-fail-");
        await withPinnedEnv(dataDir, async (snapshotPath) => {
            const failing: StageDef<BaseStageStats, never, IngestStageError> = {
                meta: StageMeta.make({ key: "claude", deps: [], tags: ["ingest"], writes: [], firstValue: true }),
                run: () => Effect.fail(new DbError({ operation: "query", message: "boom" })),
            };

            const exit = await Effect.runPromiseExit(runIngestOnce(dataDir, [failing], "cold_fail"));
            expect(Exit.isFailure(exit)).toBe(true);
            expect(existsSync(snapshotPath)).toBe(false);
        });
    });
});
