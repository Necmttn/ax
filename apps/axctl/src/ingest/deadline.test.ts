import { describe, expect, it, test } from "bun:test";
import {
    FIRST_RUN_INGEST_TIMEOUT_SECONDS,
    resolveIngestDeadlineSeconds,
} from "./deadline.ts";

/**
 * The regression this file pins is a USER-VISIBLE guarantee, not an
 * implementation detail: a first `ax ingest` must be allowed to finish. The
 * shipped default was 900s while a measured full backfill took 5,136s, so every
 * first run failed with two stages reported failed (#830).
 */
describe("resolveIngestDeadlineSeconds", () => {
    test("derive-only has no shared deadline unless explicitly configured", () => {
        expect(resolveIngestDeadlineSeconds({ ...base, firstRun: false, deriveOnly: true }).seconds).toBe(0);
        expect(resolveIngestDeadlineSeconds({ ...base, firstRun: false, deriveOnly: true, knobExplicitlySet: true }).seconds).toBe(900);
    });
    const base = { configuredSeconds: 900, knobExplicitlySet: false, firstRun: false } as const;

    it("raises a first run past the incremental default", () => {
        const decision = resolveIngestDeadlineSeconds({ ...base, firstRun: true });
        expect(decision.seconds).toBe(FIRST_RUN_INGEST_TIMEOUT_SECONDS);
        expect(decision.upgraded).toBe(true);
        // The reason is operator-facing and gets printed - it must name the
        // override, or the raise looks like the tool ignoring configuration.
        expect(decision.reason).toContain("AX_INGEST_TIMEOUT_SECONDS");
    });

    it("the raised budget actually covers the measured backfill", () => {
        // 5,136s is the real number from a 3,329-session / 924,371-turn corpus.
        // A ceiling that does not clear it would reproduce the bug with a
        // bigger constant, which is the trap this assertion exists to catch.
        expect(FIRST_RUN_INGEST_TIMEOUT_SECONDS).toBeGreaterThan(5136);
    });

    it("leaves an incremental run on the configured budget", () => {
        const decision = resolveIngestDeadlineSeconds(base);
        expect(decision.seconds).toBe(900);
        expect(decision.upgraded).toBe(false);
    });

    it("never overrides an explicit knob, not even on a first run", () => {
        // An explicitly SMALL value is how a test or a CI job asks for a short
        // leash. Silently multiplying it by 16 would break exactly the caller
        // who was most specific about what they wanted.
        const decision = resolveIngestDeadlineSeconds({
            configuredSeconds: 30,
            knobExplicitlySet: true,
            firstRun: true,
        });
        expect(decision.seconds).toBe(30);
        expect(decision.upgraded).toBe(false);
    });

    it("never LOWERS a configured budget that already exceeds the ceiling", () => {
        const generous = FIRST_RUN_INGEST_TIMEOUT_SECONDS + 3600;
        const decision = resolveIngestDeadlineSeconds({
            configuredSeconds: generous,
            knobExplicitlySet: false,
            firstRun: true,
        });
        expect(decision.seconds).toBe(generous);
        expect(decision.upgraded).toBe(false);
    });

    it("is a pure function of its input", () => {
        const input = { configuredSeconds: 900, knobExplicitlySet: false, firstRun: true } as const;
        expect(resolveIngestDeadlineSeconds(input)).toEqual(resolveIngestDeadlineSeconds(input));
    });
});
