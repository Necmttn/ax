import { Deferred, Effect, Semaphore } from "effect";
import type { DbError } from "@ax/lib/errors";
import { LiveTrace } from "@ax/lib/live-traces/index";
import type { BaseStageStats, IngestContext, StageDef } from "./types.ts";

/** Max stages running their `run` Effect concurrently. Each stage has its own
 *  internal concurrency (claude=8, codex=4) hitting Surreal, so 2 stages
 *  × internal fan-out is already heavy. */
export const PIPELINE_CONCURRENCY = 4;

/** Annotate the active stage span with the numeric fields of its result stats
 *  (every stage's stats extend `BaseStageStats`). Emits `ingest.records` (the
 *  primary/largest count, used for the rows column + speed) plus each field as
 *  `ingest.count.<field>`. Surfaces as `attribute:*` SpanEvents the progress
 *  transports read; no-op when the stats carry no numeric fields. */
const annotateStageCounts = (stats: BaseStageStats): Effect.Effect<void> =>
    Effect.gen(function* () {
        const numeric = Object.entries(stats).filter(
            ([key, value]) =>
                key !== "durationMs" && typeof value === "number" && Number.isFinite(value),
        ) as ReadonlyArray<readonly [string, number]>;
        if (numeric.length === 0) return;
        const primary = numeric.reduce((max, [, value]) => Math.max(max, value), 0);
        yield* Effect.annotateCurrentSpan("ingest.records", primary);
        for (const [key, value] of numeric) {
            yield* Effect.annotateCurrentSpan(`ingest.count.${key}`, value);
        }
    });

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
                        // Annotate the stage span with its result counts (inside the
                        // span, before LiveTrace.step ends it) so progress reporters
                        // can show rows/speed. Emitted as `attribute:ingest.*`
                        // SpanEvents; consumers that don't care (e.g. the server bus)
                        // ignore them.
                        Effect.tap((stageStats) => annotateStageCounts(stageStats)),
                        LiveTrace.step(s.meta.key, {
                            "ingest.stage.tags": s.meta.tags.join(","),
                        }),
                    ),
                );
                return stats;
            }).pipe(
                Effect.tap((stats) => Deferred.succeed(deferreds.get(s.meta.key)!, stats)),
                Effect.tapCause((cause) =>
                    Deferred.failCause(deferreds.get(s.meta.key)!, cause),
                ),
            );

        const results = yield* Effect.forEach(stages, runStage, {
            concurrency: "unbounded",
        });
        return results;
    });
