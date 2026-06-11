import { describe, expect, it } from "bun:test";
import { Effect, Exit, Fiber, Layer, Schema } from "effect";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";
import { LiveTraceLayer } from "@ax/lib/live-traces/Tracer";
import {
    TraceSinkLive,
    TraceTransportTag,
    type TraceTransport,
} from "@ax/lib/live-traces/Sink";
import type { TraceEvent } from "@ax/lib/live-traces/types";
import { StageRegistryLive, type StageDef } from "./stage/registry.ts";
import { BaseStageStats, StageMeta } from "./stage/types.ts";
import { runIngest, stageEventName, withIngestRunFinish } from "./run.ts";

const fakeDb = () => {
    const tc = makeTestSurrealClient({ fallback: [] });
    return { queries: tc.captured, client: tc.client, layer: tc.layer };
};

const stage = (key: string, deps: string[] = []): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () => Effect.succeed(BaseStageStats.make({ durationMs: 1, summary: `${key} done` })),
});

const traceLayer = () => {
    const events: TraceEvent[] = [];
    const transport: TraceTransport = {
        send: (batch) =>
            Effect.sync(() => {
                for (const event of batch) events.push(event);
            }),
    };
    const transportLayer = Layer.succeed(TraceTransportTag, transport);
    const sink = TraceSinkLive({ flushIntervalMs: 1 }).pipe(Layer.provide(transportLayer));
    return Layer.mergeAll(sink, LiveTraceLayer.pipe(Layer.provide(sink)));
};

describe("stageEventName", () => {
    it("uses canonical event labels for registered stages", () => {
        expect(stageEventName("skills")).toEqual({ source: "skills", stage: "upsert" });
        expect(stageEventName("commands")).toEqual({ source: "commands", stage: "upsert" });
        expect(stageEventName("pricing")).toEqual({ source: "pricing", stage: "models" });
        expect(stageEventName("turn-analysis")).toEqual({ source: "turn-analysis", stage: "derive" });
        expect(stageEventName("unknown-provider")).toEqual({ source: "unknown-provider", stage: "run" });
    });
});

describe("withIngestRunFinish", () => {
    const finishWrites = (queries: string[]) =>
        queries.filter((q) => q.startsWith("UPDATE ingest_run:`r1`"));

    it("writes status ok on success", async () => {
        const db = fakeDb();
        const result = await Effect.runPromise(
            withIngestRunFinish(db.client, "r1")(Effect.succeed("done")),
        );
        expect(result).toBe("done");
        const writes = finishWrites(db.queries);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('status = "ok"');
    });

    it("writes status error with the failure text and re-fails", async () => {
        class BoomError extends Schema.TaggedErrorClass<BoomError>("BoomError")("BoomError", {
            message: Schema.String,
        }) {}
        const db = fakeDb();
        const exit = await Effect.runPromiseExit(
            withIngestRunFinish(db.client, "r1")(Effect.fail(new BoomError({ message: "boom" }))),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const writes = finishWrites(db.queries);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('status = "error"');
        expect(writes[0]).toContain("boom");
    });

    it("writes status partial + interrupted on fiber interruption (progress is saved)", async () => {
        const db = fakeDb();
        const fiber = Effect.runFork(
            withIngestRunFinish(db.client, "r1")(Effect.never),
        );
        // Let the fiber start (and register the onExit finalizer) first.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await Effect.runPromise(Fiber.interrupt(fiber));
        const writes = finishWrites(db.queries);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('status = "partial"');
        expect(writes[0]).toContain("interrupted");
    });

    it("writes status error on a defect so the row never stays running", async () => {
        const db = fakeDb();
        const exit = await Effect.runPromiseExit(
            withIngestRunFinish(db.client, "r1")(Effect.die(new Error("kaboom"))),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const writes = finishWrites(db.queries);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('status = "error"');
        expect(writes[0]).toContain("kaboom");
    });
});

describe("runIngest", () => {
    it("writes run and stage lifecycle events without CLI progress services", async () => {
        const db = fakeDb();
        const registry = StageRegistryLive([stage("skills"), stage("commands", ["skills"])]);
        const program = runIngest({
            command: "ingest",
            args: [],
            cwd: "/tmp/ax",
            now: () => new Date("2026-05-29T00:00:00.000Z"),
            runId: () => "test_run",
        }).pipe(Effect.provide(Layer.mergeAll(db.layer, registry, traceLayer())));

        const result = await Effect.runPromise(program as Effect.Effect<unknown, never, never>);

        expect(result).toEqual({
            runId: "test_run",
            selectedStages: ["skills", "commands"],
            status: "ok",
            // BaseStageStats carries only durationMs (excluded) + summary, so
            // the numeric totals are empty here.
            totals: {},
        });
        const sql = db.queries.join("\n");
        expect(sql).toContain("UPSERT ingest_run:`test_run`");
        expect(sql).toContain("UPSERT ingest_stage:`test_run__skills__upsert`");
        expect(sql).toContain("UPSERT ingest_stage:`test_run__commands__upsert`");
        expect(sql).toContain("status = \"ok\"");
    });

    it("sums numeric stage stats into totals (excluding durationMs)", async () => {
        const db = fakeDb();
        const statStage: StageDef = {
            meta: StageMeta.make({ key: "skills", deps: [], tags: ["ingest"] }),
            run: () =>
                Effect.succeed({
                    ...BaseStageStats.make({ durationMs: 5, summary: "skills done" }),
                    sessions: 3,
                    failedFiles: 2,
                }),
        };
        const registry = StageRegistryLive([statStage]);
        const program = runIngest({
            command: "ingest",
            args: [],
            cwd: "/tmp/ax",
            now: () => new Date("2026-05-29T00:00:00.000Z"),
            runId: () => "test_run",
        }).pipe(Effect.provide(Layer.mergeAll(db.layer, registry, traceLayer())));

        const result = await Effect.runPromise(
            program as Effect.Effect<unknown, never, never>,
        ) as { totals: Record<string, number> };

        expect(result.totals).toEqual({ sessions: 3, failedFiles: 2 });
    });

    it("rejects reset with stage filters before deleting graph rows", async () => {
        const db = fakeDb();
        const registry = StageRegistryLive([stage("skills")]);
        const program = runIngest({
            command: "ingest",
            args: ["--reset", "--stages=skills"],
            cwd: "/tmp/ax",
            now: () => new Date("2026-05-29T00:00:00.000Z"),
            runId: () => "test_run",
        }).pipe(Effect.provide(Layer.mergeAll(db.layer, registry)));

        await expect(Effect.runPromise(program as Effect.Effect<unknown, never, never>))
            .rejects.toThrow(/--reset rebuilds the whole skill graph/);
        expect(db.queries.join("\n")).not.toContain("DELETE invoked");
    });
});
