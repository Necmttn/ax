import { afterEach, beforeEach, describe, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbError } from "@ax/lib/errors";
import type { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { AxConfigTest } from "@ax/lib/config";
import { ProcessServiceTest } from "@ax/lib/process";
import type { IngestLockInfo } from "@ax/lib/ingest-lock";
import { StageRegistry, StageRegistryLive, type StageDef } from "../ingest/stage/registry.ts";
import { BaseStageStats, StageMeta } from "../ingest/stage/types.ts";
import type { RunIngestOptions } from "../ingest/run.ts";
import { InMemoryIngestStreamBus } from "./ingest-stream.ts";
import type { IngestStreamEvent } from "../ingest/stream-events.ts";
import { startIngestWorkflow } from "./ingest-workflow.ts";

const fakeDb = () => {
    const tc = makeTestSurrealClient({ fallback: [] });
    return { queries: tc.captured, layer: tc.layer };
};

const { dylibPath, dtest } = await duckdbTestSetup("ingest workflow");

const stage = (key: string, deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () => Effect.succeed(BaseStageStats.make({ durationMs: 1, summary: `${key} done` })),
});

/** A stage that fails inside the pipeline - the tracer DOES wrap this, so it
 * emits TraceEnd{status:error} → mapped to run_finished{failed} by the transport. */
const failingStage = (key: string, deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () => Effect.fail(new DbError({ operation: "query", message: `${key} blew up` })),
});

let dataDir: string;
let oldDylib: string | undefined;
beforeEach(() => {
    // Isolated per-test dataDir: startIngestWorkflow now single-flights
    // through `<dataDir>/ingest.lock` (#F3) - without this override
    // AxConfigLive's real default (~/.local/share/ax) would have every test
    // acquire/release an actual lock file on the machine running the suite.
    dataDir = mkdtempSync(join(tmpdir(), "ax-ingest-workflow-"));
    oldDylib = process.env.AX_DUCKDB_DYLIB;
    if (dylibPath !== null) process.env.AX_DUCKDB_DYLIB = dylibPath;
});
afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (oldDylib === undefined) delete process.env.AX_DUCKDB_DYLIB;
    else process.env.AX_DUCKDB_DYLIB = oldDylib;
});

const baseServices = (dbLayer: Layer.Layer<SurrealClient>, registry: Layer.Layer<StageRegistry, unknown>) => {
    const process = ProcessServiceTest({
        route: () => new Error("ProcessService not expected in this test"),
    });
    const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
    // `provideMerge` re-exposes FileSystem/Path alongside AxConfig - both the
    // config build AND the workflow's own lock-file IO need them (IngestBaseServices).
    return Layer.mergeAll(
        dbLayer,
        registry,
        AxConfigTest({ paths: { dataDir } }).pipe(Layer.provideMerge(platform)),
        process,
    );
};

const opts = (): RunIngestOptions => ({
    command: "ingest",
    args: [],
    cwd: "/tmp/ax",
    now: () => new Date("2026-05-29T00:00:00.000Z"),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitForFinish = async (
    bus: InMemoryIngestStreamBus,
    runId: string,
    timeoutMs = 5000,
): Promise<readonly IngestStreamEvent[]> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const history = bus.history(runId);
        if (history.some((e) => e.kind === "run_finished")) return history;
        await sleep(20);
    }
    return bus.history(runId);
};

const countTerminal = (history: readonly IngestStreamEvent[]): number =>
    history.filter((e) => e.kind === "run_finished").length;

describe("startIngestWorkflow", () => {
    dtest("forks the pipeline and publishes run_started..run_finished to the bus", async () => {
        const db = fakeDb();
        const registry = StageRegistryLive([stage("skills"), stage("commands", ["skills"])]);
        const bus = new InMemoryIngestStreamBus();

        // The no-op stages never touch AxConfig/ProcessService, but runIngest's
        // signature requires them, so the baseLayer must supply all four services.
        const baseLayer = baseServices(db.layer, registry);

        // Fork must run on a runtime that outlives startIngestWorkflow's return.
        const { runId } = await Effect.runPromise(startIngestWorkflow(opts(), bus, baseLayer));
        expect(typeof runId).toBe("string");
        expect(runId.length).toBeGreaterThan(0);

        // Daemon is forked: poll the bus until run_finished, then assert the full sequence.
        const history = await waitForFinish(bus, runId);

        const kinds = history.map((e) => e.kind);
        expect(kinds[0]).toBe("run_started");
        expect(kinds.at(-1)).toBe("run_finished");

        const started = history.find((e) => e.kind === "stage_started");
        const finished = history.find((e) => e.kind === "stage_finished");
        expect(started).toBeDefined();
        expect(finished).toBeDefined();

        const runFinished = history.find((e) => e.kind === "run_finished");
        expect(runFinished && runFinished.kind === "run_finished" && runFinished.status).toBe("completed");

        // Exactly one terminal event in the happy path.
        expect(countTerminal(history)).toBe(1);

        // Every event carries the returned runId.
        for (const e of history) expect(e.runId).toBe(runId);
    });

    dtest("publishes exactly one terminal run_finished{failed} when a stage fails (normal-failure path)", async () => {
        const db = fakeDb();
        const registry = StageRegistryLive([failingStage("skills")]);
        const bus = new InMemoryIngestStreamBus();

        const { runId } = await Effect.runPromise(
            startIngestWorkflow(opts(), bus, baseServices(db.layer, registry)),
        );

        const history = await waitForFinish(bus, runId);

        const runFinished = history.find((e) => e.kind === "run_finished");
        expect(runFinished && runFinished.kind === "run_finished" && runFinished.status).toBe("failed");
        // The tracer emitted TraceEnd{error}; the synthetic terminal must NOT double-fire.
        expect(countTerminal(history)).toBe(1);
        for (const e of history) expect(e.runId).toBe(runId);
    });

    dtest("publishes a synthetic terminal run_finished{failed} on an early layer failure", async () => {
        const db = fakeDb();
        const registry = Layer.effect(StageRegistry, Effect.fail(new Error("registry build failed")));
        const bus = new InMemoryIngestStreamBus();

        const { runId } = await Effect.runPromise(
            startIngestWorkflow(opts(), bus, baseServices(db.layer, registry)),
        );

        const history = await waitForFinish(bus, runId);

        // No run_started/stage events arrived (failure was before the tracer);
        // the only terminal event is the synthetic failed one.
        const runFinished = history.find((e) => e.kind === "run_finished");
        expect(runFinished).toBeDefined();
        expect(runFinished && runFinished.kind === "run_finished" && runFinished.status).toBe("failed");
        expect(countTerminal(history)).toBe(1);
        for (const e of history) expect(e.runId).toBe(runId);
    });

    dtest("single-flight (#F3): skips the pipeline and publishes a clean run_finished{failed} when the CLI lock is held", async () => {
        const db = fakeDb();
        const registry = StageRegistryLive([stage("skills")]);
        const bus = new InMemoryIngestStreamBus();

        // A fresh lock owned by a live pid that is NOT us - withIngestLock treats
        // this exactly like a concurrent CLI/watcher ingest already running. pid 1
        // is always alive (its owner is root, so the liveness probe gets EPERM,
        // which still means alive).
        //
        // It must not be OUR pid: a lock file naming this process while this
        // process is not registered as holding it is, by definition, a leftover
        // from a crashed earlier run (or a pid the OS reused), and the lock
        // deliberately takes that over rather than wedging ingestion forever.
        writeFileSync(
            join(dataDir, "ingest.lock"),
            JSON.stringify({ pid: 1, startedAt: Date.now(), command: "cli-ingest" } satisfies IngestLockInfo),
        );

        const { runId } = await Effect.runPromise(
            startIngestWorkflow(opts(), bus, baseServices(db.layer, registry)),
        );

        const history = await waitForFinish(bus, runId);

        // The busy skip must never run the pipeline - no run_started/stage events.
        expect(history.some((e) => e.kind === "run_started")).toBe(false);
        const runFinished = history.find((e) => e.kind === "run_finished");
        expect(runFinished && runFinished.kind === "run_finished" && runFinished.status).toBe("failed");
        expect(countTerminal(history)).toBe(1);

        // The held lock is untouched - a busy skip must not steal/clobber it.
        const held = JSON.parse(readFileSync(join(dataDir, "ingest.lock"), "utf8")) as IngestLockInfo;
        expect(held.command).toBe("cli-ingest");
    });
});
