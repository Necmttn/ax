import { describe, expect, test } from "bun:test";
import { computeSpendMode, DEFAULT_SPEND_CONFIG, JUDGMENT_STRONG_RE } from "./spend-mode.ts";
import type { QuotaSnapshot } from "./spend-mode.ts";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const snap = (o: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
    v: 1,
    fetched_at: new Date(NOW - 30_000).toISOString(), // 30s old → fresh
    five_hour: { utilization: 10, resets_at: new Date(NOW + 3 * 3600_000).toISOString() },
    seven_day: { utilization: 40, resets_at: new Date(NOW + 12 * 3600_000).toISOString() }, // 12h to reset, 60% left
    ...o,
});

describe("computeSpendMode", () => {
    test("splurge: 7d near reset (<24h) + headroom (>25%) + no window near cap", () => {
        const r = computeSpendMode(snap(), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("splurge");
        expect(r.stale).toBe(false);
    });
    test("conserve: 7d NOT near reset (resets in 3 days)", () => {
        const r = computeSpendMode(snap({ seven_day: { utilization: 40, resets_at: new Date(NOW + 72 * 3600_000).toISOString() } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
    });
    test("conserve: 7d near reset but low headroom (only 20% left)", () => {
        const r = computeSpendMode(snap({ seven_day: { utilization: 80, resets_at: new Date(NOW + 12 * 3600_000).toISOString() } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve"); // 100-80=20 not > 25
    });
    test("conserve: a window near its cap (5h at 85%) blocks splurge even with 7d headroom", () => {
        const r = computeSpendMode(snap({ five_hour: { utilization: 85, resets_at: new Date(NOW + 3600_000).toISOString() } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve"); // capFloorPct=80, 85>=80
    });
    test("conserve + stale when cache older than stalenessMs", () => {
        const r = computeSpendMode(snap({ fetched_at: new Date(NOW - 10 * 60_000).toISOString() }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
        expect(r.stale).toBe(true);
    });
    test("conserve when seven_day is null", () => {
        expect(computeSpendMode(snap({ seven_day: null }), NOW, DEFAULT_SPEND_CONFIG).mode).toBe("conserve");
    });
    test("the 5h window never triggers splurge on its own (7d far from reset)", () => {
        const r = computeSpendMode(snap({
            five_hour: { utilization: 10, resets_at: new Date(NOW + 60 * 60_000).toISOString() }, // 5h resets in 1h, lots left
            seven_day: { utilization: 40, resets_at: new Date(NOW + 72 * 3600_000).toISOString() }, // 7d far
        }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
    });
    test("resets_at parse failure on 7d → conserve", () => {
        const r = computeSpendMode(snap({ seven_day: { utilization: 40, resets_at: "not-a-date" } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
    });
});

describe("JUDGMENT_STRONG_RE", () => {
    test("matches strong judgment kinds", () => {
        for (const s of ["quality review of X", "PR review", "final review", "design the migration", "audit the auth", "architect the layer", "adversarial review", "code review", "judge the reports"]) {
            expect(JUDGMENT_STRONG_RE.test(s)).toBe(true);
        }
    });
    test("does NOT match spec review (deliberate route-down class)", () => {
        expect(JUDGMENT_STRONG_RE.test("spec review of PR #42")).toBe(false);
        expect(JUDGMENT_STRONG_RE.test("spec-compliance review")).toBe(false);
    });
});
