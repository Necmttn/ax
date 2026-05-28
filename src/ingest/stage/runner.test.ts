import { describe, expect, it } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { runPipeline, topoLayers } from "./runner.ts";
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
            for (let i = 0; i < 50 && !finished.includes("claude"); i++) {
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
