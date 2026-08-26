import { describe, expect, test } from "bun:test";
import { deriveReserveMs, deriveStageBudget, DERIVE_RESERVE_SECONDS } from "./derive-budget.ts";

describe("deriveReserveMs", () => {
    test("defaults to 30s", () => {
        expect(deriveReserveMs({} as NodeJS.ProcessEnv)).toBe(DERIVE_RESERVE_SECONDS * 1000);
        expect(DERIVE_RESERVE_SECONDS).toBe(30);
    });

    test("honours AX_DERIVE_RESERVE_SECONDS, including 0", () => {
        expect(deriveReserveMs({ AX_DERIVE_RESERVE_SECONDS: "5" } as NodeJS.ProcessEnv)).toBe(5_000);
        expect(deriveReserveMs({ AX_DERIVE_RESERVE_SECONDS: "0" } as NodeJS.ProcessEnv)).toBe(0);
        expect(deriveReserveMs({ AX_DERIVE_RESERVE_SECONDS: "junk" } as NodeJS.ProcessEnv)).toBe(30_000);
    });
});

describe("deriveStageBudget", () => {
    const now = 1_000_000;

    test("uses the static cap when the deadline is far away", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 900_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 1,
        })).toEqual({ _tag: "capped", capMs: 300_000 });
    });

    test("shrinks to the remaining budget when the deadline is nearer than the static cap", () => {
        // 100s left, minus a 30s reserve => 70s for this stage, not the full 300s.
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 100_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 1,
        })).toEqual({ _tag: "capped", capMs: 70_000 });
    });

    test("skips once the reserve is all that is left - the run must finalize itself", () => {
        const budget = deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 30_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 1,
        });
        expect(budget._tag).toBe("skip");
    });

    test("skips when the deadline has already passed", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now - 1,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 1,
        })._tag).toBe("skip");
    });

    test("no deadline: the static cap still applies (today's behaviour)", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: null,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 1,
        })).toEqual({ _tag: "capped", capMs: 300_000 });
    });

    test("no deadline and a disabled static cap: uncapped", () => {
        expect(deriveStageBudget({
            staticCapMs: 0,
            deadlineMs: null,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 1,
        })).toEqual({ _tag: "uncapped" });
    });

    test("disabled static cap still respects the deadline", () => {
        expect(deriveStageBudget({
            staticCapMs: 0,
            deadlineMs: now + 100_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 1,
        })).toEqual({ _tag: "capped", capMs: 70_000 });
    });

    test("no deadline: remainingDeriveStages > 1 still uncaps (infinity / N is infinity)", () => {
        expect(deriveStageBudget({
            staticCapMs: 0,
            deadlineMs: null,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 5,
        })).toEqual({ _tag: "uncapped" });
    });

    test("two remaining derive stages split the time-to-deadline evenly", () => {
        // 200s left, minus a 30s reserve => 170s to split two ways => 85s each,
        // not the 170s a single starter would have claimed under the old code.
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 200_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 2,
        })).toEqual({ _tag: "capped", capMs: 85_000 });
    });

    test("four remaining derive stages each get a quarter of the time to the deadline", () => {
        // 400s left, minus a 30s reserve => 370s split four ways => 92.5s each.
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 400_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 4,
        })).toEqual({ _tag: "capped", capMs: 92_500 });
    });

    test("the static cap still bounds a stage's share even with many remaining stages", () => {
        // Plenty of time to the deadline, but only 2 remaining stages share it -
        // each would get more than the static cap, so the static cap wins.
        expect(deriveStageBudget({
            staticCapMs: 60_000,
            deadlineMs: now + 900_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 2,
        })).toEqual({ _tag: "capped", capMs: 60_000 });
    });

    test("a non-positive remainingDeriveStages is treated as 1, never divides by zero", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 100_000,
            nowMs: now,
            reserveMs: 30_000,
            remainingDeriveStages: 0,
        })).toEqual({ _tag: "capped", capMs: 70_000 });
    });
});
