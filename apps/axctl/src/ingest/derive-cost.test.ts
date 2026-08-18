import { describe, expect, it } from "bun:test";
import {
    estimateUncoveredSeconds,
    UNCOVERED_COST_FALLBACK_FACTOR,
} from "./derive-cost.ts";

/**
 * #831. The estimator answered a narrower question than it was asked: it timed
 * one harness's transcript parsing and reported that as the whole run. Measured
 * consequence - estimate `~33m44s`, actual 5,136s.
 */
describe("estimateUncoveredSeconds", () => {
    it("prefers the machine's own last successful run over any shipped factor", () => {
        const est = estimateUncoveredSeconds({
            parseSeconds: 100,
            prior: { wallSeconds: 5_136, totalStageSeconds: 8_371, uncoveredStageSeconds: 8_353 },
        });
        expect(est.basis).toBe("prior-run");
        // wall x uncovered share = 5136 x (8353/8371) ~= 5125. NOT 8,353: summing
        // stage-seconds and calling them wall time is the trap this converts away.
        expect(est.seconds).toBe(5_125);
        expect(est.seconds).toBeLessThan(8_353);
    });

    it("does NOT scale the prior measurement by the backlog", () => {
        // This is the whole design decision, so it gets an assertion. The
        // uncovered stages are sized by the corpus and the repo set, not the
        // backlog: on the measured warm re-pass over the SAME corpus,
        // `claude-config` went 203s -> 637s while the backlog went to nearly
        // nothing. Scaling this term with the backlog would rebuild the original
        // bug in the warm case.
        const small = estimateUncoveredSeconds({
            parseSeconds: 1,
            prior: { wallSeconds: 5_136, totalStageSeconds: 8_371, uncoveredStageSeconds: 8_353 },
        });
        const large = estimateUncoveredSeconds({
            parseSeconds: 10_000,
            prior: { wallSeconds: 5_136, totalStageSeconds: 8_371, uncoveredStageSeconds: 8_353 },
        });
        expect(small.seconds).toBe(large.seconds);
    });

    it("falls back to the measured factor when there is no history", () => {
        const est = estimateUncoveredSeconds({ parseSeconds: 1_000 });
        expect(est.basis).toBe("fallback-factor");
        // parse + uncovered must come to the factor, so the factor describes the
        // WHOLE run rather than just the extra.
        expect(1_000 + est.seconds).toBe(1_000 * UNCOVERED_COST_FALLBACK_FACTOR);
    });

    it("the fallback would have caught the real 3x miss", () => {
        // The reported estimate was ~2,024s of projected parse work against
        // 5,136s actual. The old model returned the parse figure as the total.
        const est = estimateUncoveredSeconds({ parseSeconds: 2_024 });
        const total = 2_024 + est.seconds;
        // Not exact - it is one measurement - but it must land in the right
        // order of magnitude instead of being 3x low.
        expect(total).toBeGreaterThan(4_000);
        expect(total).toBeLessThan(6_500);
    });

    it("ignores a useless prior rather than dividing by it", () => {
        for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            const est = estimateUncoveredSeconds({
                parseSeconds: 100,
                prior: { wallSeconds: 100, totalStageSeconds: 200, uncoveredStageSeconds: bad },
            });
            expect(est.basis).toBe("fallback-factor");
        }
    });

    it("fabricates nothing when there is nothing to go on", () => {
        // No sample and no history: the honest answer is zero here, and the
        // caller already renders "couldn't time a sample" rather than an ETA.
        const est = estimateUncoveredSeconds({ parseSeconds: 0 });
        expect(est.seconds).toBe(0);
    });

    it("never returns a negative estimate", () => {
        expect(estimateUncoveredSeconds({ parseSeconds: -100 }).seconds).toBe(0);
    });
});
