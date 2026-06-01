import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { DbError } from "@ax/lib/errors";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { AxConfigLive } from "@ax/lib/config";
import { ProcessServiceTest } from "@ax/lib/process";
import { StageRegistry, StageRegistryLive, type StageDef } from "../ingest/stage/registry.ts";
import { BaseStageStats, StageMeta } from "../ingest/stage/types.ts";
import type { RunIngestOptions } from "../ingest/run.ts";
import { InMemoryIngestStreamBus } from "./ingest-stream.ts";
import type { IngestStreamEvent } from "../ingest/stream-events.ts";
import { startIngestWorkflow } from "./ingest-workflow.ts";

const fakeDb = () => {
    const queries: string[] = [];
    const client: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>(sql: string) =>
            Effect.sync(() => {
                queries.push(sql);
                return [] as unknown as T;
            }),
        upsert: () => Effect.succeed({}),
        relate: () => Effect.succeed({}),
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as SurrealClientShape["raw"],
    };
    return { queries, layer: Layer.succeed(SurrealClient, client) };
};

/** A fake DB whose first query fails - simulates a DbError thrown BEFORE the
 * tracer wraps the pipeline (the `buildIngestRunStartStatement` query in
 * runIngest runs before `LiveTrace.withTrace`), so no TraceEnd is ever emitted. */
const fakeFailingDb = () => {
    let calls = 0;
    const client: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>() =>
            Effect.suspend(() => {
                calls += 1;
                if (calls === 1) {
                    return Effect.fail(
                        new DbError({ operation: "query", message: "boom: run-start failed" }),
                    ) as Effect.Effect<T, DbError>;
                }
                return Effect.succeed([] as unknown as T);
            }),
        upsert: () => Effect.succeed({}),
        relate: () => Effect.succeed({}),
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: {} as SurrealClientShape["raw"],
    };
    return { layer: Layer.succeed(SurrealClient, client) };
};

const stage = (key: string, deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () => Effect.succeed(BaseStageStats.make({ durationMs: 1, summary: `${key} done` })),
});

/** A stage that fails inside the pipeline - the tracer DOES wrap this, so it
 * emits TraceEnd{status:error} → mapped to run_finished{failed} by the transport. */
const failingStage = (key: string, deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () => Effect.fail(new DbError({ operation: "stage", message: `${key} blew up` })),
});

const baseServices = (dbLayer: Layer.Layer<SurrealClient>, registry: Layer.Layer<StageRegistry>) => {
    const process = ProcessServiceTest({
        route: () => new Error("ProcessService not expected in this test"),
    });
    return Layer.mergeAll(dbLayer, registry, AxConfigLive, process);
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
    it("forks the pipeline and publishes run_started..run_finished to the bus", async () => {
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

    it("publishes exactly one terminal run_finished{failed} when a stage fails (normal-failure path)", async () => {
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

    it("publishes a synthetic terminal run_finished{failed} on early failure before the tracer (no TraceEnd)", async () => {
        // First DB query (run-start) fails before LiveTrace.withTrace wraps the
        // pipeline, so no TraceEnd is ever emitted - only the synthetic terminal
        // event from the catchCause handler can terminate the stream.
        const db = fakeFailingDb();
        const registry = StageRegistryLive([stage("skills")]);
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
});
