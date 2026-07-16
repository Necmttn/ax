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
import { annotateStageProgress, deriveStageTimeoutSeconds, heartbeatSeconds, PIPELINE_CONCURRENCY, runPipeline, stageFileFailureAnnotator, topoLayers } from "./runner.ts";
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

// The failure collector fires its onFailure hook deep inside per-file child
// spans (transcripts.file etc.). `stageFileFailureAnnotator` must pin the
// snapshot to the STAGE span captured at StageDef.run entry, not whatever
// span happens to be current at emission time - otherwise the Live tab keys
// the skipped-file list to a phantom stage name.
describe("stageFileFailureAnnotator", () => {
    it("emits the snapshot on the stage span even when invoked inside a nested child span", async () => {
        const events: TraceEvent[] = [];
        const ctx = IngestContext.make({ cwd: "/tmp/ax", since: new Date(0), debug: false });
        const snapshot = {
            total: 3,
            failures: [{ filePath: "/p/a.jsonl", tag: "DbError", message: "boom" }],
        };

        const demo: StageDef = {
            meta: StageMeta.make({ key: "demo", deps: [], tags: ["ingest"] }),
            run: () =>
                Effect.gen(function* () {
                    const onFileFailures = yield* stageFileFailureAnnotator;
                    // Emit from inside a child span, like the per-file loops do.
                    yield* Effect.withSpan(onFileFailures(snapshot), "demo.file");
                    return BaseStageStats.make({ durationMs: 1, summary: "demo done" });
                }),
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

        const failureEvent = events.find(
            (e) => e._tag === "SpanEvent" && e.name === "attribute:ingest.fileFailures",
        );
        expect(failureEvent).toBeDefined();
        const value = failureEvent && "attributes" in failureEvent ? failureEvent.attributes?.value : null;
        expect(JSON.parse(String(value))).toEqual(snapshot);

        // Keyed to the stage span: the SpanEvent's spanId must be the span
        // whose SpanStart carries the stage name, not the nested child span.
        const stageStart = events.find(
            (e) => e._tag === "SpanStart" && e.name === "demo",
        );
        const childStart = events.find(
            (e) => e._tag === "SpanStart" && e.name === "demo.file",
        );
        expect(stageStart).toBeDefined();
        expect(childStart).toBeDefined();
        if (failureEvent?._tag === "SpanEvent" && stageStart?._tag === "SpanStart" && childStart?._tag === "SpanStart") {
            expect(failureEvent.spanId).toBe(stageStart.spanId);
            expect(failureEvent.spanId).not.toBe(childStart.spanId);
        }
    });

    it("emits nothing for an empty snapshot or outside any span", async () => {
        const events: TraceEvent[] = [];
        const ctx = IngestContext.make({ cwd: "/tmp/ax", since: new Date(0), debug: false });

        const demo: StageDef = {
            meta: StageMeta.make({ key: "demo", deps: [], tags: ["ingest"] }),
            run: () =>
                Effect.gen(function* () {
                    const onFileFailures = yield* stageFileFailureAnnotator;
                    yield* onFileFailures({ total: 0, failures: [] });
                    return BaseStageStats.make({ durationMs: 1, summary: "clean" });
                }),
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
        expect(
            events.some((e) => e._tag === "SpanEvent" && e.name === "attribute:ingest.fileFailures"),
        ).toBe(false);

        // Outside any span (plain CLI/test context): the hook is a no-op, not a crash.
        const hook = await Effect.runPromise(stageFileFailureAnnotator);
        await Effect.runPromise(hook({ total: 5, failures: [] }));
    });
});

describe("heartbeatSeconds / deriveStageTimeoutSeconds", () => {
    it("heartbeatSeconds: default 30, honors override, rejects negative/NaN", () => {
        expect(heartbeatSeconds({})).toBe(30);
        expect(heartbeatSeconds({ AX_INGEST_HEARTBEAT_SECONDS: "10" })).toBe(10);
        expect(heartbeatSeconds({ AX_INGEST_HEARTBEAT_SECONDS: "0" })).toBe(0);
        expect(heartbeatSeconds({ AX_INGEST_HEARTBEAT_SECONDS: "-5" })).toBe(30);
        expect(heartbeatSeconds({ AX_INGEST_HEARTBEAT_SECONDS: "abc" })).toBe(30);
    });

    it("deriveStageTimeoutSeconds: default 300, honors override, rejects negative/NaN", () => {
        expect(deriveStageTimeoutSeconds({})).toBe(300);
        expect(deriveStageTimeoutSeconds({ AX_STAGE_TIMEOUT_SECONDS: "120" })).toBe(120);
        expect(deriveStageTimeoutSeconds({ AX_STAGE_TIMEOUT_SECONDS: "0" })).toBe(0);
        expect(deriveStageTimeoutSeconds({ AX_STAGE_TIMEOUT_SECONDS: "-1" })).toBe(300);
        expect(deriveStageTimeoutSeconds({ AX_STAGE_TIMEOUT_SECONDS: "nope" })).toBe(300);
    });
});

describe("derive-stage watchdog (#671)", () => {
    // Set/restore env vars around an async body (runPipeline reads them at call time).
    const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
        const saved: Record<string, string | undefined> = {};
        for (const k of Object.keys(vars)) {
            saved[k] = process.env[k];
            process.env[k] = vars[k];
        }
        try {
            await fn();
        } finally {
            for (const k of Object.keys(vars)) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
        }
    };

    const ctx = () => IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });

    it("fails a hung derive stage OPEN so the run finishes and downstream still runs", async () => {
        await withEnv({ AX_STAGE_TIMEOUT_SECONDS: "0.05", AX_INGEST_HEARTBEAT_SECONDS: "0" }, async () => {
            const ran: string[] = [];
            const hang: StageDef = {
                meta: StageMeta.make({ key: "hang", deps: [], tags: ["derive"] }),
                run: () => Effect.never, // never resolves → watchdog must fire
            };
            const after: StageDef = {
                meta: StageMeta.make({ key: "after", deps: ["hang"], tags: ["derive"] }),
                run: () =>
                    Effect.sync(() => {
                        ran.push("after");
                        return BaseStageStats.make({ durationMs: 0, summary: "after" });
                    }),
            };
            const results = await Effect.runPromise(
                runPipeline([hang, after], ctx()) as Effect.Effect<ReadonlyArray<BaseStageStats>, never, never>,
            );
            // Downstream ran despite the upstream hang, and the pipeline resolved.
            expect(ran).toEqual(["after"]);
            const summaries = results.map((r) => r.summary).sort();
            expect(summaries).toContain("after");
            expect(summaries).toContain("timed out (watchdog)");
        });
    });

    it("does NOT watchdog a non-derive (ingest) stage that runs past the cap", async () => {
        await withEnv({ AX_STAGE_TIMEOUT_SECONDS: "0.05", AX_INGEST_HEARTBEAT_SECONDS: "0" }, async () => {
            const slowIngest: StageDef = {
                meta: StageMeta.make({ key: "slow", deps: [], tags: ["ingest"] }),
                run: () =>
                    Effect.sync(() => BaseStageStats.make({ durationMs: 0, summary: "real" })).pipe(
                        Effect.delay("150 millis"), // 3× the cap, but ingest stages are exempt
                    ),
            };
            const results = await Effect.runPromise(
                runPipeline([slowIngest], ctx()) as Effect.Effect<ReadonlyArray<BaseStageStats>, never, never>,
            );
            expect(results[0]!.summary).toBe("real");
        });
    });
});

describe("runPipeline derive budget (#697)", () => {
    const ctx = IngestContext.make({ cwd: "/tmp", since: new Date(0), debug: false });

    const stage = (
        key: string,
        tags: ReadonlyArray<"ingest" | "derive">,
        run: Effect.Effect<BaseStageStats, never, never>,
    ): StageDef<BaseStageStats, never> => ({
        meta: StageMeta.make({ key, deps: [], tags }),
        run: () => run,
    });

    const instant = (key: string, tags: ReadonlyArray<"ingest" | "derive">) =>
        stage(key, tags, Effect.succeed(BaseStageStats.make({ durationMs: 0, summary: `${key} ok` })));

    /** A stage that would run far past any test's patience. */
    const hangs = (key: string, tags: ReadonlyArray<"ingest" | "derive">) =>
        stage(key, tags, Effect.never as Effect.Effect<BaseStageStats, never, never>);

    it("a derive stage past the deadline is skipped and the pass still completes", async () => {
        const stats = await Effect.runPromise(
            runPipeline([instant("claude", ["ingest"]), hangs("derive-metrics", ["derive"])], ctx, {
                deadlineMs: Date.now() - 1, // budget already blown, as after a backlog
                reserveMs: 0,
            }) as Effect.Effect<ReadonlyArray<BaseStageStats>, never, never>,
        );

        // The real observable effect: the pipeline RETURNS instead of hanging
        // until the outer 900s timeout guillotines it (and leaves a cooldown lock).
        expect(stats).toHaveLength(2);
        const derive = stats.find((s) => s.summary.includes("skipped"));
        expect(derive).toBeDefined();
        expect(stats.some((s) => s.summary === "claude ok")).toBe(true);
    });

    it("a derive stage is capped by the time left, not its static 300s cap", async () => {
        const started = Date.now();
        const stats = await Effect.runPromise(
            runPipeline([hangs("outcomes", ["derive"])], ctx, {
                deadlineMs: Date.now() + 150,
                reserveMs: 0,
            }) as Effect.Effect<ReadonlyArray<BaseStageStats>, never, never>,
        );

        // Bounded by the deadline (150ms), NOT by AX_STAGE_TIMEOUT_SECONDS (300s).
        // Either summary proves the DEADLINE (not the 300s static cap) bounded
        // the stage: "timed out" if the budget read still saw time left when
        // the stage started, "skipped" if CI scheduling slop pushed pipeline
        // startup past the 150ms deadline before the stage got its permit.
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(stats[0]?.summary).toMatch(/timed out|skipped/);
    });

    it("an ingest-tagged stage is exempt - a real backfill legitimately runs long", async () => {
        const stats = await Effect.runPromise(
            runPipeline([instant("skills", ["ingest"])], ctx, {
                deadlineMs: Date.now() - 1,
                reserveMs: 0,
            }) as Effect.Effect<ReadonlyArray<BaseStageStats>, never, never>,
        );

        // Provider stages must not be skipped by the derive budget: if the
        // `!tags.includes("derive")` exemption in runner.ts were dropped, this
        // stage would be budgeted like any derive, the deadline is already
        // blown, and it would read the sentinel "skipped (out of budget)"
        // summary instead of actually running.
        expect(stats[0]?.summary).toBe("skills ok");
    });

    it("suspends the budget read until the derive stage actually starts, not when it's built (#697 finding 1)", async () => {
        // Saturate every pipeline permit with slow no-dep `ingest` stages so
        // the derive stage below is forced to WAIT for one. If the budget
        // were read eagerly (at stage-build time, which happens near t=0 for
        // every dep-free stage regardless of permit availability), the
        // 150ms-out deadline still looks open and the derive gets a live cap
        // - it then runs (once a permit frees up ~200ms later) and times out
        // at the watchdog. If the budget is correctly suspended until the
        // derive stage actually starts (post-permit, ~200ms in), the deadline
        // has already passed and it's skipped instead - never even starting
        // the timed body. The two behaviors are distinguishable both by
        // summary and by wall-clock (~200ms vs ~350ms).
        const started = Date.now();
        const saturators = Array.from({ length: PIPELINE_CONCURRENCY }, (_, i) =>
            stage(
                `hold-${i}`,
                ["ingest"],
                Effect.succeed(BaseStageStats.make({ durationMs: 0, summary: `hold-${i} ok` })).pipe(
                    Effect.delay("200 millis"),
                ),
            ),
        );
        const derive = hangs("derive-metrics", ["derive"]);

        const stats = await Effect.runPromise(
            runPipeline([...saturators, derive], ctx, {
                deadlineMs: started + 150,
                reserveMs: 0,
            }) as Effect.Effect<ReadonlyArray<BaseStageStats>, never, never>,
        );

        const deriveResult = stats.find(
            (s) => s.summary.includes("skipped") || s.summary.includes("timed out"),
        );
        // THE load-bearing assertion. Suspended (correct): the budget is read
        // once the permit frees, by which time the deadline has passed -> skip.
        // Eager (broken): the budget is read at build time, when 150ms still
        // remained -> the body runs and the watchdog times it out instead.
        expect(deriveResult?.summary).toBe("skipped (out of budget)");
        // Generous: the summary above is what pins the suspend. This only
        // guards against the pipeline hanging - a tight bound here just makes
        // the test flaky on a loaded box.
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("no deadline: unchanged behaviour (stages run to completion)", async () => {
        const stats = await Effect.runPromise(
            runPipeline([instant("claude", ["ingest"]), instant("outcomes", ["derive"])], ctx) as Effect.Effect<ReadonlyArray<BaseStageStats>, never, never>,
        );
        expect(stats.map((s) => s.summary).sort()).toEqual(["claude ok", "outcomes ok"]);
    });
});
