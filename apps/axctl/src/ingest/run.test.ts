import { describe, expect, it } from "bun:test";
import { Effect, Exit, Fiber, Layer, Schema } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
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
    return { queries, client, layer: Layer.succeed(SurrealClient, client) };
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

    it("writes status error + interrupted on fiber interruption", async () => {
        const db = fakeDb();
        const fiber = Effect.runFork(
            withIngestRunFinish(db.client, "r1")(Effect.never),
        );
        // Let the fiber start (and register the onExit finalizer) first.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await Effect.runPromise(Fiber.interrupt(fiber));
        const writes = finishWrites(db.queries);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toContain('status = "error"');
        expect(writes[0]).toContain("interrupted");
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
        });
        const sql = db.queries.join("\n");
        expect(sql).toContain("UPSERT ingest_run:`test_run`");
        expect(sql).toContain("UPSERT ingest_stage:`test_run__skills__upsert`");
        expect(sql).toContain("UPSERT ingest_stage:`test_run__commands__upsert`");
        expect(sql).toContain("status = \"ok\"");
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
