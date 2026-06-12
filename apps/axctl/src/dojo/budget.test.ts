// apps/axctl/src/dojo/budget.test.ts
import { describe, expect, test } from "bun:test";
import type { QuotaSnapshot } from "../quota/schema.ts";
import { computeBudgetEnvelope } from "./budget.ts";

const NOW_MS = Date.parse("2026-06-13T10:00:00.000Z");

const snapshot = (fiveHourUtil: number, sevenDayUtil: number): QuotaSnapshot => ({
    v: 1,
    fetched_at: "2026-06-13T09:59:00.000Z",
    five_hour: { utilization: fiveHourUtil, resets_at: "2026-06-13T12:00:00.000Z" },
    seven_day: { utilization: sevenDayUtil, resets_at: "2026-06-15T00:00:00.000Z" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
});

describe("computeBudgetEnvelope", () => {
    test("binding window is the one with least remaining; reserve subtracted", () => {
        const env = computeBudgetEnvelope(snapshot(40, 70), {}, NOW_MS);
        expect(env.binding_window).toBe("seven_day");
        expect(env.window_remaining_pct).toBe(30);
        expect(env.reserve_pct).toBe(15);
        expect(env.spendable_pct).toBe(15);
        expect(env.has_surplus).toBe(true);
        expect(env.deadline).toBe("2026-06-13T12:00:00.000Z"); // earliest reset
        expect(env.source).toBe("quota");
    });

    test("no surplus when remaining <= reserve", () => {
        const env = computeBudgetEnvelope(snapshot(95, 50), {}, NOW_MS);
        expect(env.binding_window).toBe("five_hour");
        expect(env.spendable_pct).toBe(0);
        expect(env.has_surplus).toBe(false);
    });

    test("--budget override caps spendable but never exceeds remaining", () => {
        const env = computeBudgetEnvelope(snapshot(40, 70), { budgetPctOverride: 50 }, NOW_MS);
        expect(env.spendable_pct).toBe(30); // min(50, remaining 30)
        expect(env.source).toBe("override");
    });

    test("--until override replaces the deadline", () => {
        const env = computeBudgetEnvelope(
            snapshot(40, 70),
            { untilIso: "2026-06-13T11:30:00.000Z" },
            NOW_MS,
        );
        expect(env.deadline).toBe("2026-06-13T11:30:00.000Z");
    });

    test("force grants a floor budget when there is no surplus", () => {
        const env = computeBudgetEnvelope(snapshot(99, 99), { force: true }, NOW_MS);
        expect(env.has_surplus).toBe(true);
        expect(env.spendable_pct).toBe(1); // whatever actually remains
        expect(env.source).toBe("forced");
    });

    test("null snapshot (no token / fetch failed): unavailable, no surplus unless forced", () => {
        const env = computeBudgetEnvelope(null, {}, NOW_MS);
        expect(env.has_surplus).toBe(false);
        expect(env.source).toBe("unavailable");
        expect(env.binding_window).toBeNull();
        const forced = computeBudgetEnvelope(null, { force: true }, NOW_MS);
        expect(forced.has_surplus).toBe(true);
        expect(forced.source).toBe("forced");
    });

    test("missing windows are skipped; lone five_hour window binds", () => {
        const snap: QuotaSnapshot = { ...snapshot(80, 0), seven_day: null };
        const env = computeBudgetEnvelope(snap, {}, NOW_MS);
        expect(env.binding_window).toBe("five_hour");
        expect(env.window_remaining_pct).toBe(20);
    });
});
