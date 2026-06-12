import { describe, expect, test } from "bun:test";
import { computeStreak } from "./streak.ts";

// Dates are "YYYY-MM-DD" UTC day keys, as produced by
// time::format(ts, "%Y-%m-%d") in SurrealQL (UTC per spec decision).
describe("computeStreak", () => {
    test("counts consecutive days ending today", () => {
        const r = computeStreak(["2026-06-10", "2026-06-11", "2026-06-12"], "2026-06-12");
        expect(r).toEqual({ active_days: 3, streak_days: 3 });
    });

    test("streak survives when today has no activity yet (grace = yesterday)", () => {
        const r = computeStreak(["2026-06-09", "2026-06-10", "2026-06-11"], "2026-06-12");
        expect(r.streak_days).toBe(3);
    });

    test("gap older than yesterday breaks the streak", () => {
        const r = computeStreak(["2026-06-01", "2026-06-02", "2026-06-10"], "2026-06-12");
        expect(r).toEqual({ active_days: 3, streak_days: 0 });
    });

    test("gap inside the run stops the count", () => {
        const r = computeStreak(["2026-06-08", "2026-06-10", "2026-06-11", "2026-06-12"], "2026-06-12");
        expect(r.streak_days).toBe(3);
    });

    test("empty input", () => {
        expect(computeStreak([], "2026-06-12")).toEqual({ active_days: 0, streak_days: 0 });
    });

    test("duplicate dates are deduped", () => {
        const r = computeStreak(["2026-06-12", "2026-06-12"], "2026-06-12");
        expect(r).toEqual({ active_days: 1, streak_days: 1 });
    });
});
