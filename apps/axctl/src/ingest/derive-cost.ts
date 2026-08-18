/**
 * The part of an ingest's cost the calibration sample cannot see (#831).
 *
 * THE BUG. `ax ingest --dry-run` estimated `~33m44s`; the run took **5,136s**,
 * about 3x more. The estimator times a sample of sessions from ONE harness,
 * derives a sessions/sec rate, and multiplies by the remaining session count.
 * Measured per-stage durations from that very run show what that model covers:
 *
 *     claude-sidecars 2507s   signals 2256s   codex 1629s   git 945s
 *     claude-config 203s      session-health 221s   proposals 218s
 *     claude 18s   <- the sampled stage
 *
 * A FALSE START WORTH RECORDING. The first version of this module blamed
 * "whole-corpus derive stages" and sized them per 1,000 turns. That model is
 * wrong, and the warm re-pass proves it: `signals` went 2,256s cold to **21s**
 * warm (107x) because derive stages ARE windowed by the since-window. A
 * per-turn derive coefficient would have over-predicted a warm run by an order
 * of magnitude - trading a 3x under-estimate for a worse over-estimate.
 *
 * WHAT IS ACTUALLY MISSING. Not "derives" as a category, but **every stage the
 * sample never observed**. The sample times `claude` (18s) or `codex` transcript
 * parsing. The run also does sidecar-artifact discovery, git history, config and
 * skill scanning, and the derive chain - roughly 35 other stages. Those do not
 * scale with the sampled harness's session rate, and assuming they cost ZERO is
 * the entire error. The old estimate was not 3x low by bad arithmetic; it
 * answered a narrower question than the one asked.
 *
 * THE MODEL, AND WHY IT LEANS ON HISTORY. Total = the sampled parse term
 * (unchanged) PLUS an uncovered term. The uncovered term comes from THIS
 * MACHINE's last successful run - its WALL time, times the share of its
 * stage-seconds the sample cannot observe (see {@link PriorRunObservation} for
 * why the conversion matters). That is preferred over any constant this repo
 * could ship because
 * the uncovered cost depends on corpus shape (a Codex-heavy corpus has ~10x the
 * `turn` rows per session), repo count, and disk - none of which a shipped
 * number knows. When there is no history, a measured ratio is used and the
 * estimate says it is rough. The BASIS is always reported: an estimate that
 * hides how it was reached invites the same false confidence that made a 900s
 * default look reasonable against a 34-minute job.
 */

/**
 * When there is no local history, how much bigger the whole run is than its
 * sampled stage.
 *
 * Measured once, on the cold backfill above: 8,371 stage-seconds in total
 * against 18s for the sampled `claude` stage. That literal ratio (465x) is
 * useless as a multiplier - it says more about `claude` being cheap on a
 * watermarked corpus than about anything general. What IS usable is the shape of
 * the whole run against its wall clock: 5,136s wall for a job whose sampled rate
 * projected 2,024s, i.e. **~2.5x**. Rounded to 2.5 and used only as a
 * first-run fallback, flagged rough. One sample, one machine, one corpus - it
 * exists to stop the answer being confidently 3x low, not to be precise.
 */
export const UNCOVERED_COST_FALLBACK_FACTOR = 2.5;

/**
 * What a previous successful run measured on THIS machine.
 *
 * STAGE-SECONDS ARE NOT WALL SECONDS, and conflating them is a real trap this
 * shape exists to close. Stages run concurrently, so their durations sum to far
 * more than the clock: measured, 8,371 stage-seconds over 5,136s wall on the
 * cold run (1.63x) and 1,916 over 639s on the warm one (3.0x). An earlier
 * version of this module summed the uncovered stages' durations and reported
 * that as wall time - which would have replaced a 3x UNDER-estimate with a ~3x
 * OVER-estimate. So the prior run is recorded as a wall time plus the SHARE of
 * its stage-seconds that the sample cannot observe, and the conversion happens
 * in one place below.
 */
export interface PriorRunObservation {
    /** That run's actual wall-clock duration, in seconds. */
    readonly wallSeconds: number;
    /** Summed duration of ALL its settled stages, in seconds. */
    readonly totalStageSeconds: number;
    /**
     * Summed duration of every stage EXCEPT the sampled harness's own - the work
     * a fresh sample cannot observe. Same units as `totalStageSeconds`.
     */
    readonly uncoveredStageSeconds: number;
}

export interface UncoveredCostInput {
    /** Seconds the sample's rate projects for the remaining backlog. */
    readonly parseSeconds: number;
    /** The machine's own last successful run, when there is one. */
    readonly prior?: PriorRunObservation | undefined;
}

export interface UncoveredCostEstimate {
    /** Seconds of work the sample did not observe. */
    readonly seconds: number;
    /** How it was reached - always reported, never implied. */
    readonly basis: "prior-run" | "fallback-factor";
}

/**
 * Is this prior observation safe to divide by and scale from? Every field has to
 * be a finite positive number, and the uncovered share cannot exceed the whole -
 * a malformed row must fall through to the fallback rather than produce a
 * confident wrong number.
 */
const usablePrior = (
    prior: PriorRunObservation | undefined,
): prior is PriorRunObservation =>
    prior !== undefined &&
    Number.isFinite(prior.wallSeconds) && prior.wallSeconds > 0 &&
    Number.isFinite(prior.totalStageSeconds) && prior.totalStageSeconds > 0 &&
    Number.isFinite(prior.uncoveredStageSeconds) && prior.uncoveredStageSeconds > 0 &&
    prior.uncoveredStageSeconds <= prior.totalStageSeconds;

/**
 * Estimate the cost of everything the calibration sample did not measure.
 *
 * Pure, so every branch is testable without a store or a clock. Never negative.
 * A zero `parseSeconds` with no history yields zero rather than a fabricated
 * number: with nothing measured and nothing remembered, the honest answer is
 * "no estimate", which the caller already renders.
 */
export const estimateUncoveredSeconds = (
    input: UncoveredCostInput,
): UncoveredCostEstimate => {
    const prior = input.prior;
    if (usablePrior(prior)) {
        // Convert stage-seconds to WALL seconds using that run's own observed
        // overlap, rather than a parallelism constant: wall x (uncovered share
        // of stage-seconds). Same run, same machine, same concurrency, so the
        // ratio needs no calibration of its own.
        const share = prior.uncoveredStageSeconds / prior.totalStageSeconds;
        // Deliberately NOT scaled by the backlog. The uncovered stages are
        // dominated by work whose size is the corpus and the repo set, not the
        // backlog: on the measured warm re-pass over the SAME corpus,
        // `claude-config` even got more expensive (203s -> 637s) while the
        // backlog went to nearly nothing. Scaling this term down with the
        // backlog would reproduce the original bug in the warm case.
        return { seconds: Math.round(prior.wallSeconds * share), basis: "prior-run" };
    }
    const parse = Math.max(0, input.parseSeconds);
    if (parse === 0) return { seconds: 0, basis: "fallback-factor" };
    return {
        seconds: Math.round(parse * (UNCOVERED_COST_FALLBACK_FACTOR - 1)),
        basis: "fallback-factor",
    };
};
