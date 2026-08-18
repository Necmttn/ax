import { Context, Effect } from "effect";

/**
 * How much of a stage's wall clock was its OWN database work.
 *
 * `ingest_stage` records wall clock, and with `PIPELINE_CONCURRENCY = 4` that
 * is not a stage's cost. Every DuckDB call goes through SYNCHRONOUS `bun:ffi`,
 * so it blocks the single JS thread while it runs; a stage's start-to-end gap
 * therefore includes every other stage's turn. Measured over three warm passes
 * on one real store, the stage rows summed to 1.00x of wall clock when the
 * pipeline was serialized and 2.99x-3.75x when it was not, and `claude-config`
 * read 0.4s serially against 380.2s concurrently (#841, #865).
 *
 * Attribution is EXACT rather than sampled, and for the same reason the problem
 * exists: the FFI is synchronous, so exactly one call is ever in flight, and the
 * fiber that awaits it is the fiber that issued it.
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
        const startedAt = performance.now();
        return Effect.ensuring(
            call,
            Effect.sync(() => {
                acc.ms += performance.now() - startedAt;
                acc.calls += 1;
            }),
        );
    });
