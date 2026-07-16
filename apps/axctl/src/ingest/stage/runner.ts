import { Deferred, Effect, Fiber, Option, Semaphore } from "effect";
import type { DbError } from "@ax/lib/errors";
import { LiveTrace } from "@ax/lib/live-traces/index";
import type { FileFailureSnapshot } from "../file-isolation.ts";
import { INGEST_FILE_FAILURES_KEY } from "../stream-events.ts";
import { deriveReserveMs, deriveStageBudget } from "./derive-budget.ts";
import type { BaseStageStats, IngestContext, StageDef } from "./types.ts";

/** Max stages running their `run` Effect concurrently. Each stage has its own
 *  internal concurrency (claude=8, codex=4) hitting Surreal, so 2 stages
 *  × internal fan-out is already heavy. */
export const PIPELINE_CONCURRENCY = 4;

/** How often the pipeline logs which stages are still running, so a hung or
 *  slow stage is attributable instead of looking like a silent stall (#671).
 *  Env override `AX_INGEST_HEARTBEAT_SECONDS`; 0 disables. Exported for tests. */
export const heartbeatSeconds = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = Number(env.AX_INGEST_HEARTBEAT_SECONDS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 30;
};

/** Hard per-stage cap applied to `derive`-tagged stages ONLY. Derives reshape
 *  already-ingested rows and should finish fast; one that runs past this cap is
 *  stuck (e.g. a SurrealDB query that hangs on a given server version, #671) and
 *  is failed OPEN - a warning plus empty stats - so the rest of the pipeline
 *  still completes and exits. Heavy ingest/provider stages (claude, codex, git)
 *  are deliberately exempt: a full backfill legitimately runs for many minutes.
 *  Env override `AX_STAGE_TIMEOUT_SECONDS`; 0 disables. Exported for tests. */
export const deriveStageTimeoutSeconds = (env: NodeJS.ProcessEnv = process.env): number => {
    const raw = Number(env.AX_STAGE_TIMEOUT_SECONDS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 300;
};

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

/**
 * Bridge a stage's mid-run progress counts onto the active stage span as live
 * `ingest.count.<field>` annotations. Each annotation is emitted as an
 * `attribute:ingest.*` SpanEvent immediately (see `WrappedSpan.attribute`), so
 * the progress transports' rows/speed/bar climb *while* the stage runs instead
 * of snapping to a final count only on `SpanEnd`.
 *
 * Pass this as a stage's `onProgress` hook. It must run inside the stage's
 * `LiveTrace.step` span (i.e. from within `StageDef.run`) so `annotateCurrentSpan`
 * targets the stage span. Keys like `currentFile`/`totalFiles` drive the
 * determinate bar; `records`/`sessions`/`turns`/… drive the rows column. No-op
 * for non-finite values. Mirrors {@link annotateStageCounts}' key scheme so the
 * mid-run and final counts share one parsing path in the transports.
 */
export const annotateStageProgress = (
    counts: Record<string, number>,
): Effect.Effect<void> =>
    Effect.gen(function* () {
        for (const [key, value] of Object.entries(counts)) {
            if (typeof value === "number" && Number.isFinite(value)) {
                yield* Effect.annotateCurrentSpan(`ingest.count.${key}`, value);
            }
        }
    });

/**
 * Build a hook that publishes a stage's cumulative skipped-file snapshot onto
 * the STAGE span as a JSON `ingest.fileFailures` attribute (emitted immediately
 * as an `attribute:*` SpanEvent - see `WrappedSpan.attribute` - which
 * `ingestStreamEventFromTrace` turns into a `stage_file_failures` stream
 * event for the dashboard Live tab).
 *
 * Unlike {@link annotateStageProgress}, this can NOT use
 * `Effect.annotateCurrentSpan` at emission time: the failure collector invokes
 * its `onFailure` hook deep inside per-file child spans (`transcripts.file`,
 * `codex.ingest`, ...), so the *current* span there is not the stage span and
 * the snapshot would be keyed to the wrong stage name. Instead, run this
 * effect at the top of `StageDef.run` - where the current span IS the stage's
 * `LiveTrace.step` span - to capture that span once, and pass the returned
 * hook into the stage's ingest function. Outside a live trace (plain CLI run,
 * tests) the attribute lands on a regular span (or nowhere when no span
 * exists) and nothing else changes: the CLI keeps its aggregate warn log.
 */
export const stageFileFailureAnnotator: Effect.Effect<
    (snapshot: FileFailureSnapshot) => Effect.Effect<void>
> = Effect.gen(function* () {
    const span = yield* Effect.option(Effect.currentSpan);
    return (snapshot) =>
        Effect.sync(() => {
            if (Option.isSome(span) && snapshot.total > 0) {
                span.value.attribute(INGEST_FILE_FAILURES_KEY, JSON.stringify(snapshot));
            }
        });
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
 *  the configured `TraceTransport` (ADR-0007).
 *
 *  `opts.deadlineMs` is the run's wall-clock deadline (epoch ms). Derive stages
 *  are budgeted against it so the pass ends cleanly instead of being killed by
 *  the outer ingest timeout (#697); omit it and derives keep only their static
 *  `AX_STAGE_TIMEOUT_SECONDS` cap. `opts.reserveMs` overrides the finalization
 *  reserve (env default) - tests pass 0. */
export const runPipeline = <S extends BaseStageStats, R>(
    stages: ReadonlyArray<StageDef<S, R>>,
    ctx: IngestContext,
    opts: { readonly deadlineMs?: number; readonly reserveMs?: number } = {},
): Effect.Effect<ReadonlyArray<S>, DbError, R> =>
    Effect.gen(function* () {
        topoLayers(stages); // cycle check

        const deferreds = new Map<string, Deferred.Deferred<S, DbError>>();
        for (const s of stages) {
            deferreds.set(s.meta.key, yield* Deferred.make<S, DbError>());
        }
        const sem = yield* Semaphore.make(PIPELINE_CONCURRENCY);

        // Stages currently executing (permit acquired, run not yet resolved). The
        // heartbeat reads this so a hang is attributable to a specific stage (#671).
        const inFlight = new Set<string>();
        const stageTimeoutMs = deriveStageTimeoutSeconds() * 1000;
        const deadlineMs = opts.deadlineMs ?? null;
        const reserveMs = opts.reserveMs ?? deriveReserveMs();

        const runStage = (s: StageDef<S, R>) =>
            Effect.gen(function* () {
                for (const dep of s.meta.deps) {
                    const d = deferreds.get(dep);
                    if (d) yield* Deferred.await(d);
                }
                const body = s.run(ctx).pipe(
                    // Annotate the stage span with its result counts (inside the
                    // span, before LiveTrace.step ends it) so progress reporters
                    // can show rows/speed. Emitted as `attribute:ingest.*`
                    // SpanEvents; consumers that don't care (e.g. the server bus)
                    // ignore them.
                    Effect.tap((stageStats) => annotateStageCounts(stageStats)),
                    LiveTrace.step(s.meta.key, {
                        "ingest.stage.tags": s.meta.tags.join(","),
                    }),
                );
                // Watchdog: cap `derive` stages so one stuck or backlogged derive
                // can't wedge the run OR push the pass past its deadline (#671,
                // #697). Fails OPEN - a warning plus sentinel stats - because
                // downstream deps only await this Deferred (they never read its
                // value; they re-query the DB), and the totals roll-up skips
                // `durationMs` + non-numeric fields, so an empty BaseStageStats is
                // safe. Heavy provider stages (claude, codex, git) are exempt: a
                // full backfill legitimately runs for many minutes.
                // Suspended so `Date.now()` is read at stage START (post-deps,
                // post-permit) - reading it at build time would hand every stage
                // the budget the FIRST one had.
                const guarded = !s.meta.tags.includes("derive")
                    ? body
                    : Effect.suspend(() => {
                        const budget = deriveStageBudget({
                            staticCapMs: stageTimeoutMs,
                            deadlineMs,
                            nowMs: Date.now(),
                            reserveMs,
                        });
                        if (budget._tag === "uncapped") return body;
                        if (budget._tag === "skip") {
                            return Effect.logWarning(
                                `ingest: skipping derive stage '${s.meta.key}' - ${budget.reason}.`,
                            ).pipe(
                                Effect.as({
                                    durationMs: 0,
                                    summary: "skipped (out of budget)",
                                } as unknown as S),
                            );
                        }
                        return body.pipe(
                            Effect.timeoutOrElse({
                                duration: budget.capMs,
                                orElse: () =>
                                    Effect.logWarning(
                                        `ingest: derive stage '${s.meta.key}' exceeded ${Math.round(budget.capMs / 1000)}s - ` +
                                            `skipping it (failed open) so the run can finish. ` +
                                            `Raise/disable with AX_STAGE_TIMEOUT_SECONDS.`,
                                    ).pipe(
                                        Effect.as({
                                            durationMs: budget.capMs,
                                            summary: "timed out (watchdog)",
                                        } as unknown as S),
                                    ),
                            }),
                        );
                    });
                const tracked = Effect.sync(() => {
                    inFlight.add(s.meta.key);
                }).pipe(
                    Effect.andThen(() => guarded),
                    Effect.ensuring(Effect.sync(() => {
                        inFlight.delete(s.meta.key);
                    })),
                );
                const stats: S = yield* sem.withPermits(1)(tracked);
                return stats;
            }).pipe(
                Effect.tap((stats) => Deferred.succeed(deferreds.get(s.meta.key)!, stats)),
                Effect.tapCause((cause) =>
                    Deferred.failCause(deferreds.get(s.meta.key)!, cause),
                ),
            );

        const pipeline = Effect.forEach(stages, runStage, {
            concurrency: "unbounded",
        });

        // Heartbeat: every N seconds, name the stages still running so a hang is
        // visible instead of a silent stall (#671). It's a background fiber - NOT
        // raced - because the pipeline's own result (success OR failure) must
        // propagate unchanged (`Effect.race` resolves on the first success, so a
        // failing pipeline would hang against the never-succeeding heartbeat). We
        // fork it and interrupt it once the pipeline settles either way.
        const hb = heartbeatSeconds();
        if (hb <= 0) return yield* pipeline;

        const heartbeat = Effect.suspend(() =>
            inFlight.size > 0
                ? Effect.logInfo(
                      `ingest: still running after ${hb}s - ${[...inFlight].sort().join(", ")}`,
                  )
                : Effect.void,
        ).pipe(Effect.delay(`${hb} seconds`), Effect.forever);

        const hbFiber = yield* Effect.forkChild(heartbeat);
        return yield* pipeline.pipe(Effect.ensuring(Fiber.interrupt(hbFiber)));
    });
