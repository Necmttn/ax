import { describe, expect, it } from "bun:test";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { LiveTraceLayer } from "@ax/lib/live-traces/Tracer";
import {
    TraceSinkLive,
    TraceTransportTag,
    type TraceTransport,
} from "@ax/lib/live-traces/Sink";
import type { TraceEvent } from "@ax/lib/live-traces/types";
import { LiveTrace } from "@ax/lib/live-traces/index";
import { annotateStageProgress, PIPELINE_CONCURRENCY, runPipeline, topoLayers } from "./runner.ts";
import { BaseStageStats, IngestContext, StageMeta, type StageDef } from "./types.ts";

const stage = (key: string, deps: string[]): StageDef => ({
    meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
    run: () =>
        Effect.succeed(BaseStageStats.make({ durationMs: 0, summary: key })),
});

describe("topoLayers", () => {
    it("returns leaves first, dependents last", () => {
        const layers = topoLayers([
            stage("a", []),
            stage("b", ["a"]),
            stage("c", ["b"]),
        ]);
        expect(layers).toEqual([["a"], ["b"], ["c"]]);
    });

    it("groups independent stages in one layer", () => {
        const layers = topoLayers([
            stage("a", []),
            stage("b", []),
            stage("c", ["a", "b"]),
        ]);
        expect(layers[0]?.sort()).toEqual(["a", "b"]);
        expect(layers[1]).toEqual(["c"]);
    });

    it("throws on dependency cycle", () => {
        expect(() => topoLayers([
            stage("a", ["b"]),
            stage("b", ["a"]),
        ])).toThrow(/cycle/);
    });
});

describe("runPipeline", () => {
    it("runs every stage exactly once and respects deps", async () => {
        const order: string[] = [];
        const make = (key: string, deps: string[]): StageDef => ({
            meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
            run: () =>
                Effect.sync(() => {
                    order.push(key);
                    return BaseStageStats.make({ durationMs: 0, summary: key });
                }),
        });
        const ctx = IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });
        await Effect.runPromise(
            runPipeline([
                make("a", []),
                make("b", ["a"]),
            ], ctx) as Effect.Effect<unknown, never, never>,
        );
        expect(order).toEqual(["a", "b"]);
    });

    // Regression: ax originally scheduled stages in `topoLayers` *layers*, which
    // meant a dep-free long stage (git) blocked a downstream stage (claude)
    // whose own deps (skills, commands) had already finished. The Deferred-based
    // runner must dispatch claude as soon as its deps complete, regardless of
    // any sibling dep-free stage still running. See ADR-0007 / commit bded64b
    // for the legacy `pipeline.ts` path this replaced.
    it("does not let a dep-free long stage block downstream stages whose deps are met", async () => {
        // Implicit dependency: if the semaphore had only 1 permit, git would
        // hold it forever (parked on `released`) and claude could never run.
        // Guard so a future tuning of the constant fails loudly here.
        expect(PIPELINE_CONCURRENCY).toBeGreaterThanOrEqual(2);

        // Worst-case yields: ~N*stages cooperative ticks for Effect's runloop
        // to walk skills/commands -> deferreds -> claude. 50 is generous for
        // the 4-stage fixture below.
        const MAX_YIELDS_FOR_PARALLEL_DISPATCH = 50;

        const program = Effect.gen(function* () {
            const released = yield* Deferred.make<void, never>();
            const finished: string[] = [];

            const mk = (
                key: string,
                deps: string[],
                gate?: Deferred.Deferred<void, never>,
            ): StageDef => ({
                meta: StageMeta.make({ key, deps, tags: ["ingest"] }),
                run: () =>
                    Effect.gen(function* () {
                        if (gate) yield* Deferred.await(gate);
                        finished.push(key);
                        return BaseStageStats.make({ durationMs: 0, summary: key });
                    }),
            });

            const ctx = IngestContext.make({
                cwd: "/tmp",
                since: new Date(0),
                debug: false,
            });

            const fiber = yield* Effect.forkChild(
                runPipeline(
                    [
                        mk("skills", []),
                        mk("commands", []),
                        mk("git", [], released),
                        mk("claude", ["skills", "commands"]),
                    ],
                    ctx,
                ),
            );

            // Yield repeatedly so the pipeline's parallel branches make
            // progress: skills + commands resolve, claude's deps fire, claude
            // runs. git stays parked on `released`. No setTimeout - purely
            // cooperative scheduling on Effect's runloop.
            for (
                let i = 0;
                i < MAX_YIELDS_FOR_PARALLEL_DISPATCH && !finished.includes("claude");
                i++
            ) {
                yield* Effect.yieldNow;
            }

            // Snapshot ordering claim BEFORE releasing git.
            const snapshot = [...finished];

            yield* Deferred.succeed(released, undefined);
            yield* Fiber.join(fiber);

            return { snapshot, finished };
        });

        const { snapshot, finished } = await Effect.runPromise(
            program as Effect.Effect<{ snapshot: string[]; finished: string[] }, never, never>,
        );

        // Critical: claude must have finished while git was still parked.
        expect(snapshot).toContain("claude");
        expect(snapshot).not.toContain("git");
        expect(new Set(finished)).toEqual(
            new Set(["skills", "commands", "git", "claude"]),
        );
    });
});

const traceLayer = (events: TraceEvent[]) => {
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

// The codex/claude stages were running 35s+ on an indeterminate progress bar
// because counts were only annotated on SpanEnd. `annotateStageProgress` is the
// bridge that lets a stage emit *live* `attribute:ingest.count.*` SpanEvents
// mid-run (one per finite field) so the progress transports climb rows/speed
// while the stage is still working.
describe("annotateStageProgress", () => {
    it("emits each finite count as a live attribute:ingest.count.* SpanEvent before the stage span ends", async () => {
        const events: TraceEvent[] = [];
        const ctx = IngestContext.make({ cwd: "/tmp/ax", since: new Date(0), debug: false });

        const demo: StageDef = {
            meta: StageMeta.make({ key: "demo", deps: [], tags: ["ingest"] }),
            run: () =>
                annotateStageProgress({
                    currentFile: 2,
                    totalFiles: 5,
                    records: 42,
                    notANumber: Number.NaN,
                }).pipe(
                    Effect.as(BaseStageStats.make({ durationMs: 1, summary: "demo done" })),
                ),
        };

        await Effect.runPromise(
            runPipeline([demo], ctx).pipe(
                LiveTrace.withTrace({
                    traceId: "ingest:test",
                    label: "ingest demo",
                    scope: { type: "user", id: "test" },
                }),
                Effect.provide(traceLayer(events)),
            ) as Effect.Effect<unknown, never, never>,
        );

        const names = events.map((e) => ("name" in e ? e.name : e._tag));
        const spanEndIdx = events.findIndex((e) => e._tag === "SpanEnd");
        const progressIdxs = events
            .map((e, i) =>
                e._tag === "SpanEvent" && e.name.startsWith("attribute:ingest.count.") ? i : -1,
            )
            .filter((i) => i >= 0);

        // The finite progress fields surfaced as count SpanEvents...
        expect(names).toContain("attribute:ingest.count.currentFile");
        expect(names).toContain("attribute:ingest.count.totalFiles");
        expect(names).toContain("attribute:ingest.count.records");
        // ...the non-finite value was skipped...
        expect(names).not.toContain("attribute:ingest.count.notANumber");
        // ...and all fired before the span ended (live deltas, not on SpanEnd).
        expect(progressIdxs.length).toBe(3);
        expect(spanEndIdx).toBeGreaterThanOrEqual(0);
        expect(Math.max(...progressIdxs)).toBeLessThan(spanEndIdx);

        const recordsEvent = events.find(
            (e) => e._tag === "SpanEvent" && e.name === "attribute:ingest.count.records",
        );
        const recordsValue =
            recordsEvent && "attributes" in recordsEvent ? recordsEvent.attributes?.value : null;
        expect(recordsValue).toBe(42);
    });
});
