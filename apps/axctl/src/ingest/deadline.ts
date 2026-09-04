/**
 * How long a single `ax ingest` is allowed to run, and why a fixed default
 * cannot answer that question (#830).
 *
 * THE BUG THIS EXISTS TO FIX. `AX_INGEST_TIMEOUT_SECONDS` defaulted to 900 for
 * every run, cold or warm. Measured on a real machine: `ax ingest --dry-run`
 * estimated `~33m44s` for the backlog, the run was killed at 900s, and two
 * stages were reported failed. The full backfill actually needed **5,136s**.
 * So the shipped default could not finish a backfill the tool itself estimated
 * at 34 minutes, and a new user's very first ingest was guaranteed to fail.
 *
 * WHY NOT JUST RAISE THE NUMBER. Because the two cases have opposite needs. A
 * warm incremental run should NOT be allowed to grind for hours - a 900s cap
 * there is a useful "something is wrong" tripwire, and the ordinary warm run
 * finishes in 26s. A first run over a multi-gigabyte transcript corpus is a
 * different job that legitimately takes hours. One constant cannot be both, so
 * the deadline is resolved per run instead of baked in.
 *
 * WHY NOT DERIVE IT FROM THE DRY-RUN ESTIMATE. That was the first design, and
 * it is wrong TODAY: the estimator itself under-predicts a large backfill by
 * roughly 3x (it extrapolates per-session over the REMAINING sessions, while
 * the dominant stages scale with the whole corpus - #831). Sizing a deadline
 * from a number known to be 3x low would reintroduce the same failure with more
 * machinery. When #831 lands, revisit this: an accurate estimate plus a margin
 * beats a generous constant. Until then, a generous constant for the cold case
 * is the honest choice, and it is stated as such rather than tuned to look
 * precise.
 *
 * The resolver is PURE and the caller gathers the facts, so every branch is
 * unit-testable without a store, a clock, or a filesystem.
 */

/**
 * Ceiling for a first-run backfill: 4 hours.
 *
 * Rationale, not numerology: the measured full cold backfill on a 3,329-session
 * / 924,371-turn corpus was 5,136s (1h26m). Four hours is ~2.8x that, which
 * covers a corpus several times larger while still bounding a genuinely wedged
 * run rather than letting it live forever. It is a backstop, not a target.
 */
export const FIRST_RUN_INGEST_TIMEOUT_SECONDS = 4 * 60 * 60;

export interface IngestDeadlineInput {
    /** `cfg.knobs.ingestTimeoutSeconds` - the env knob, or its default. */
    readonly configuredSeconds: number;
    /**
     * Did the operator set `AX_INGEST_TIMEOUT_SECONDS` themselves? An explicit
     * value is never overridden - including an explicit SMALL one, which is how
     * a test or a CI job asks for a short leash on purpose.
     */
    readonly knobExplicitlySet: boolean;
    /**
     * Is this the first ingest into this store? Determined by the caller (no
     * published snapshot yet). A first run has no watermarks, so every
     * transcript, commit and skill on disk is read for the first time.
     */
    readonly firstRun: boolean;
    /** Derive-only runs have no shared deadline unless explicitly requested. */
    readonly deriveOnly?: boolean;
}

export interface IngestDeadlineDecision {
    readonly seconds: number;
    /** True when the first-run ceiling replaced the configured value. */
    readonly upgraded: boolean;
    /** Operator-facing explanation; printed when `upgraded`. */
    readonly reason: string;
}

/**
 * Resolve the wall-clock budget for one ingest run.
 *
 * Precedence, highest first:
 *  1. An explicit `AX_INGEST_TIMEOUT_SECONDS` - the operator's word is final.
 *  2. A first run on an empty store - raise to the first-run ceiling.
 *  3. Otherwise the configured value, unchanged.
 */
export const resolveIngestDeadlineSeconds = (
    input: IngestDeadlineInput,
): IngestDeadlineDecision => {
    if (input.knobExplicitlySet) {
        return {
            seconds: input.configuredSeconds,
            upgraded: false,
            reason: "AX_INGEST_TIMEOUT_SECONDS was set explicitly",
        };
    }
    if (input.deriveOnly) {
        return {
            seconds: 0,
            upgraded: false,
            reason: "derive-only uses AX_STAGE_HUNG_SECONDS unless a shared timeout is explicit",
        };
    }
    if (!input.firstRun) {
        return {
            seconds: input.configuredSeconds,
            upgraded: false,
            reason: "incremental run against an existing store",
        };
    }
    // A configured default that already covers a backfill needs no help. Guards
    // against this function ever LOWERING a deadline, which would be a silent
    // regression for anyone who raised the shipped default.
    if (input.configuredSeconds >= FIRST_RUN_INGEST_TIMEOUT_SECONDS) {
        return {
            seconds: input.configuredSeconds,
            upgraded: false,
            reason: "configured budget already covers a first run",
        };
    }
    return {
        seconds: FIRST_RUN_INGEST_TIMEOUT_SECONDS,
        upgraded: true,
        reason:
            `first ingest into this store - raised the wall-clock budget from ` +
            `${input.configuredSeconds}s to ${FIRST_RUN_INGEST_TIMEOUT_SECONDS}s. ` +
            `A full backfill reads every transcript on disk and was measured at ` +
            `5,136s, so the incremental default cannot finish one. ` +
            `Set AX_INGEST_TIMEOUT_SECONDS to override.`,
    };
};
