import { describe, expect, test } from "bun:test";
import { createLedger } from "./ledger.ts";

describe("createLedger", () => {
    test("navigate within window after prefetch counts as hit", () => {
        const l = createLedger(5000);
        l.recordPrefetch("/sessions/abc", 1000);
        l.recordNavigate("/sessions/abc", 3000);
        expect(l.snapshot()).toEqual({
            fired: 1,
            hits: 1,
            errors: 0,
            navigations: 1,
            hitRate: 1,
        });
    });

    test("navigate after window is not a hit", () => {
        const l = createLedger(5000);
        l.recordPrefetch("/sessions/abc", 1000);
        l.recordNavigate("/sessions/abc", 6001);
        expect(l.snapshot().hits).toBe(0);
        expect(l.snapshot().navigations).toBe(1);
    });

    test("navigate to a key never prefetched is not a hit", () => {
        const l = createLedger(5000);
        l.recordNavigate("/cost", 1000);
        expect(l.snapshot()).toEqual({
            fired: 0,
            hits: 0,
            errors: 0,
            navigations: 1,
            hitRate: 0,
        });
    });

    test("errors counted separately, do not affect fired", () => {
        const l = createLedger(5000);
        l.recordError("/sessions/abc", 1000);
        expect(l.snapshot().errors).toBe(1);
        expect(l.snapshot().fired).toBe(0);
    });

    test("re-prefetch refreshes the window", () => {
        const l = createLedger(5000);
        l.recordPrefetch("/x", 1000);
        l.recordPrefetch("/x", 10_000);
        l.recordNavigate("/x", 12_000);
        const s = l.snapshot();
        expect(s.fired).toBe(2);
        expect(s.hits).toBe(1);
        expect(s.hitRate).toBe(0.5);
    });

    test("hitRate is 0 when nothing fired", () => {
        expect(createLedger().snapshot().hitRate).toBe(0);
    });
});
