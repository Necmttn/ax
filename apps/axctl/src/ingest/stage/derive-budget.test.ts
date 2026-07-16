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
        })).toEqual({ _tag: "capped", capMs: 300_000 });
    });

    test("shrinks to the remaining budget when the deadline is nearer than the static cap", () => {
        // 100s left, minus a 30s reserve => 70s for this stage, not the full 300s.
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 100_000,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "capped", capMs: 70_000 });
    });

    test("skips once the reserve is all that is left - the run must finalize itself", () => {
        const budget = deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now + 30_000,
            nowMs: now,
            reserveMs: 30_000,
        });
        expect(budget._tag).toBe("skip");
    });

    test("skips when the deadline has already passed", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: now - 1,
            nowMs: now,
            reserveMs: 30_000,
        })._tag).toBe("skip");
    });

    test("no deadline: the static cap still applies (today's behaviour)", () => {
        expect(deriveStageBudget({
            staticCapMs: 300_000,
            deadlineMs: null,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "capped", capMs: 300_000 });
    });

    test("no deadline and a disabled static cap: uncapped", () => {
        expect(deriveStageBudget({
            staticCapMs: 0,
            deadlineMs: null,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "uncapped" });
    });

    test("disabled static cap still respects the deadline", () => {
        expect(deriveStageBudget({
            staticCapMs: 0,
            deadlineMs: now + 100_000,
            nowMs: now,
            reserveMs: 30_000,
        })).toEqual({ _tag: "capped", capMs: 70_000 });
    });
});
