import { Deferred, Effect, Semaphore } from "effect";
import type { DbError } from "../../lib/errors.ts";
import { LiveTrace } from "../../lib/live-traces/index.ts";
import type { BaseStageStats, IngestContext, StageDef } from "./types.ts";

/** Max stages running their `run` Effect concurrently. Each stage has its own
 *  internal concurrency (claude=8, codex=4) hitting Surreal, so 2 stages
 *  × internal fan-out is already heavy. */
export const PIPELINE_CONCURRENCY = 2;

/** Kahn's algorithm; throws on cycle. Layers are useful for diagnostics, but
 *  `runPipeline` uses Deferreds for tighter scheduling (no layer barriers). */
export const topoLayers = <S extends BaseStageStats, R>(
    stages: ReadonlyArray<StageDef<S, R>>,
): string[][] => {
    const keys = new Set(stages.map((s) => s.meta.key));
    const done = new Set<string>();
    const layers: string[][] = [];
    let remaining: ReadonlyArray<StageDef<S, R>> = stages;
    while (remaining.length > 0) {
        const ready = remaining.filter((s) =>
            s.meta.deps.filter((d) => keys.has(d)).every((d) => done.has(d)),
        );
        if (ready.length === 0) {
            throw new Error(
                `ingest pipeline: dependency cycle among ${remaining
                    .map((s) => s.meta.key)
                    .join(", ")}`,
            );
        }
        layers.push(ready.map((s) => s.meta.key));
        for (const s of ready) done.add(s.meta.key);
        remaining = remaining.filter((s) => !done.has(s.meta.key));
    }
    return layers;
};

/** Run the given stages with DAG scheduling. Each stage waits for its in-graph
 *  deps via Deferreds; only `PIPELINE_CONCURRENCY` are inside the semaphore at
 *  once. Each stage is wrapped in `LiveTrace.step` so progress flows through
 *  the configured `TraceTransport` (ADR-0007). */
export const runPipeline = <S extends BaseStageStats, R>(
    stages: ReadonlyArray<StageDef<S, R>>,
    ctx: IngestContext,
): Effect.Effect<ReadonlyArray<S>, DbError, R> =>
    Effect.gen(function* () {
        topoLayers(stages); // cycle check

        const deferreds = new Map<string, Deferred.Deferred<S, DbError>>();
        for (const s of stages) {
            deferreds.set(s.meta.key, yield* Deferred.make<S, DbError>());
        }
        const sem = yield* Semaphore.make(PIPELINE_CONCURRENCY);

        const runStage = (s: StageDef<S, R>) =>
            Effect.gen(function* () {
                for (const dep of s.meta.deps) {
                    const d = deferreds.get(dep);
                    if (d) yield* Deferred.await(d);
                }
                const stats: S = yield* sem.withPermits(1)(
                    s.run(ctx).pipe(
                        LiveTrace.step(s.meta.key, {
                            "ingest.stage.tags": s.meta.tags.join(","),
                        }),
                    ),
                );
                return stats;
            }).pipe(
                Effect.tap((stats) => Deferred.succeed(deferreds.get(s.meta.key)!, stats)),
                Effect.tapCause((cause) =>
                    Deferred.failCause(deferreds.get(s.meta.key)!, cause as never),
                ),
            );

        const results = yield* Effect.forEach(stages, runStage, {
            concurrency: "unbounded",
        });
        return results;
    });
