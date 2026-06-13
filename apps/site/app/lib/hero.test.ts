import { describe, expect, test } from "bun:test";
import { monthlyUsd, buildHero } from "./hero";
import type { ProfileV1 } from "./community";

const base: ProfileV1 = {
    v: 1,
    github: "necmttn",
    generated_at: "2026-06-13T00:00:00Z",
    window_days: 30,
    stats: {
        sessions: 142,
        active_days: 26,
        streak_days: 12,
        tokens: { prompt: 1, completion: 1, total: 38_000_000 },
        cost_usd: 214.3,
        models: [{ name: "fable", share: 0.6 }, { name: "haiku", share: 0.4 }],
        harnesses: ["claude-code"],
    },
    rig: { skills: [{ name: "tdd", source: "superpowers", runs: 88 }], hooks: [], routing_table: true },
};

describe("monthlyUsd", () => {
    test("30-day window passes through", () => {
        expect(monthlyUsd(200, 30)).toBe(200);
    });
    test("14-day window scales up to a month", () => {
        expect(monthlyUsd(140, 14)).toBeCloseTo(300);
    });
    test("zero/negative window does not divide by zero", () => {
        expect(monthlyUsd(50, 0)).toBe(50);
    });
});

describe("buildHero", () => {
    test("derives monthly spend, counts, and provenance", () => {
        const h = buildHero(base);
        expect(h.monthlyUsd).toBeCloseTo(214.3);
        expect(h.models).toBe(2);
        expect(h.skills).toBe(1);
        expect(h.sessions).toBe(142);
        expect(h.provenance).toBe("measured from 142 sessions over 30d · not a screenshot");
    });
    test("--no-cost profile omits monthly spend", () => {
        const { cost_usd: _omit, ...stats } = base.stats;
        const h = buildHero({ ...base, stats });
        expect(h.monthlyUsd).toBeUndefined();
    });
    test("singular session phrasing", () => {
        const h = buildHero({ ...base, stats: { ...base.stats, sessions: 1 } });
        expect(h.provenance).toContain("1 session over");
    });
});
