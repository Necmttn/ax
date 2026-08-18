import { Context, Data, Effect } from "effect";

/**
 * How much of a stage's wall clock was its OWN database work.
 *
 * `ingest_stage` records wall clock, and with `PIPELINE_CONCURRENCY = 4` that
 * is not a stage's cost: a stage's start-to-end gap includes every other
 * stage's turn on the shared write connection. Measured over three warm passes
 * on one real store, the stage rows summed to 1.00x of wall clock when the
 * pipeline was serialized and 2.99x-3.75x when it was not, and `claude-config`
 * read 0.4s serially against 380.2s concurrently (#841, #865).
 *
 * Attribution is per-call WALL TIME (start-to-settle of each database call).
 * Under the original synchronous `bun:ffi` client this was exact by
 * construction - one call ever in flight, thread blocked. The napi driver
 * (#880) keeps calls on one connection serialized, so a call's wall time
 * still measures its own execution PLUS any time it queued behind another
 * stage's call on the same connection; self_ms therefore stays honest at
 * serial concurrency and reads as an upper bound when stages share a
 * connection concurrently.
 */
export interface StageSelfTime {
    /** Milliseconds spent inside this stage's own DuckDB calls. */
    ms: number;
    /** How many calls that was, so a mean is available without a second field. */
    calls: number;
}

export const makeStageSelfTime = (): StageSelfTime => ({ ms: 0, calls: 0 });

/**
 * The accumulator the CURRENT stage is charging its database calls to, or null
 * outside a stage (CLI reads, the dashboard, tests).
 *
 * A `Context.Reference` is inherited by child fibers, which is what makes this
 * correct for stages that fan out internally (claude parses 8 files at a time).
 * Same mechanism as `LiveSpanRef` in `../live-traces/LiveTrace.ts`.
 */
export const CurrentStageSelfTime: Context.Reference<StageSelfTime | null> = Context
    .Reference<StageSelfTime | null>("@ax/duckdb/CurrentStageSelfTime", {
        defaultValue: () => null,
    });

/**
 * The self-time budget (ms) the CURRENT derive stage may spend inside its own
 * DuckDB calls, or null when nothing is enforcing one (provider stages, CLI
 * reads, tests). Provided by the ingest runner around derive-tagged stage
 * bodies ONLY.
 *
 * This exists because a wall-clock cap measures the wrong quantity here:
 * calls on the shared write connection are serialized, so under
 * PIPELINE_CONCURRENCY=4 a stage's wall clock is mostly OTHER stages'
 * calls. Measured on a real store, a stage whose own cost was 2.1s tripped a
 * 300s wall cap on every concurrent run and had its output discarded (#837).
 * Self time is the stage's actual cost, so it is what the cap must bind.
 */
export const CurrentStageSelfTimeBudget: Context.Reference<number | null> = Context
    .Reference<number | null>("@ax/duckdb/CurrentStageSelfTimeBudget", {
        defaultValue: () => null,
    });

/**
 * Raised (as a DEFECT, via `Effect.die`) when a stage has already spent its
 * self-time budget and asks for another database call. A defect rather than a
 * typed failure so the seam's signature stays `Effect<A, E, R>` - callers of
 * `CacheRead`/`CacheWriteService` never see this in their error channel; only
 * the ingest runner catches it (by `instanceof`, out of `cause.reasons`) and
 * converts it to a fail-open `timeout` stage outcome.
 *
 * Enforcement is cooperative and happens BETWEEN calls: one long call may
 * overshoot the budget and it is the NEXT call that is refused. (Under the
 * original synchronous FFI client an in-flight call could not be preempted at
 * all - the event loop was blocked, #837. The napi driver (#880) makes an
 * in-flight statement interruptible via fiber interruption; the budget check
 * itself deliberately stays between-calls, unchanged.)
 */
export class StageSelfTimeBudgetExceeded extends Data.TaggedError("StageSelfTimeBudgetExceeded")<{
    readonly selfMs: number;
    readonly budgetMs: number;
    readonly calls: number;
}> {}

/**
 * Charge `call`'s elapsed time to whichever stage is running.
 *
 * Outside a stage the accumulator is null and the effect is returned untouched,
 * so the only cost on the CLI/dashboard read path is one context lookup. The
 * timer stops on EVERY exit - success, failure, interruption - because a call
 * that was interrupted still consumed the thread.
 */
export const chargeStageSelfTime = <A, E, R>(
    call: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
    // `withFiber` reads the reference off the RUNNING fiber, which is the same
    // read `LiveTraceLogger` does (../live-traces/Logger.ts). Going through the
    // fiber keeps the requirement channel clean: charging a call must not add
    // a service dependency to every caller of the seam.
    Effect.withFiber((fiber) => {
        const acc = fiber.getRef(CurrentStageSelfTime);
        if (acc === null) return call;
        const budgetMs = fiber.getRef(CurrentStageSelfTimeBudget);
        if (budgetMs !== null && acc.ms >= budgetMs) {
            // Refuse the call outright: the stage has spent its budget, and
            // one more statement would hold the shared connection for an
            // unbounded further stretch. Work already persisted stays
            // persisted (ingest is incremental); the runner converts this
            // defect into a `timeout` row so the refusal is visible (#837).
            return Effect.die(
                new StageSelfTimeBudgetExceeded({
                    selfMs: acc.ms,
                    budgetMs,
                    calls: acc.calls,
                }),
            );
        }
        const startedAt = performance.now();
        return Effect.ensuring(
            call,
            Effect.sync(() => {
                acc.ms += performance.now() - startedAt;
                acc.calls += 1;
            }),
        );
    });
