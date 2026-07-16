/**
 * How long may a derive stage run, given the pass's own deadline? (#697)
 *
 * The static watchdog (`AX_STAGE_TIMEOUT_SECONDS`, #671) caps ONE derive at
 * 300s but knows nothing about the run's wall-clock budget
 * (`AX_INGEST_TIMEOUT_SECONDS`, 900s). Under a backlog the provider stages eat
 * most of the budget, then each derive starts a fresh 300s clock and pushes the
 * pass past the outer cap. The outer timeout is not a soft landing: it
 * deliberately LEAVES the ingest lock as a cooldown (see ingest-lock.ts), so
 * the watcher's next fires skip and a human is left re-running ingest by hand.
 *
 * So a derive gets `min(staticCap, timeLeftBeforeDeadline - reserve)`, and is
 * skipped outright once only the reserve remains. The reserve is what the run
 * needs to finalize its own `ingest_run` row and exit clean.
 *
 * This bounds the pass. It does NOT make a heavy derive finish - that wants
 * chunked/resumable derive (#689).
 */
import { nonNegativeNumberEnv } from "@ax/lib/shared/env-number";

/** What a derive stage is allowed this pass. */
export type DeriveStageBudget =
    /** Run it with no timeout (no deadline and the static cap is disabled). */
    | { readonly _tag: "uncapped" }
    /** Run it, but time it out after `capMs`. */
    | { readonly _tag: "capped"; readonly capMs: number }
    /** Don't start it: there is no budget left. */
    | { readonly _tag: "skip"; readonly reason: string };

/** Wall-clock held back from derives so the run can finalize its `ingest_run`
 *  row (and the outer lock release) instead of being guillotined mid-write. */
export const DERIVE_RESERVE_SECONDS = 30;

/** `AX_DERIVE_RESERVE_SECONDS`; 0 is a legal "no reserve". A blank value
 *  (unset-but-exported) falls back to the default rather than reading as an
 *  explicit 0 - see {@link nonNegativeNumberEnv}. Exported for tests. */
export const deriveReserveMs = (env: NodeJS.ProcessEnv = process.env): number =>
    nonNegativeNumberEnv(env.AX_DERIVE_RESERVE_SECONDS, DERIVE_RESERVE_SECONDS) * 1000;

/**
 * Budget for the derive stage about to start. `staticCapMs <= 0` disables the
 * static cap; `deadlineMs === null` means the caller has no wall-clock budget
 * (tests, `--derive-only` invocations without a timeout), in which case this
 * degrades to exactly today's static-cap behaviour.
 */
export const deriveStageBudget = (input: {
    readonly staticCapMs: number;
    readonly deadlineMs: number | null;
    readonly nowMs: number;
    readonly reserveMs: number;
}): DeriveStageBudget => {
    const untilDeadline = input.deadlineMs === null
        ? Number.POSITIVE_INFINITY
        : input.deadlineMs - input.reserveMs - input.nowMs;
    if (untilDeadline <= 0) {
        return {
            _tag: "skip",
            reason: "no time left before the ingest deadline (raise AX_INGEST_TIMEOUT_SECONDS, " +
                "or run 'ax ingest --derive-only' to catch derives up)",
        };
    }
    const staticCap = input.staticCapMs > 0 ? input.staticCapMs : Number.POSITIVE_INFINITY;
    const capMs = Math.min(staticCap, untilDeadline);
    return Number.isFinite(capMs) ? { _tag: "capped", capMs } : { _tag: "uncapped" };
};
