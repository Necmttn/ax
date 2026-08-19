import { describe, expect, it } from "bun:test";
import { Effect, Exit, Fiber, Layer, Schema } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { AxConfigTest } from "@ax/lib/config";
import { ProcessServiceLive } from "@ax/lib/process";
import { withIngestLock } from "@ax/lib/ingest-lock";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { LiveTraceLayer } from "@ax/lib/live-traces/Tracer";
import { TraceSinkLive, TraceTransportTag, type TraceTransport } from "@ax/lib/live-traces/Sink";
import { StageRegistryLive, type StageDef } from "./stage/registry.ts";
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
