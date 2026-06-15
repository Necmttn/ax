import { describe, expect, test } from "bun:test";
import { agoText, fmtReset, renderQuotaTable, renderStatusline, renderSwiftBar } from "./format.ts";
import type { QuotaSnapshot } from "./schema.ts";

const NOW_MS = Date.parse("2026-06-12T12:00:00.000Z");
const UTC = { nowMs: NOW_MS, timeZone: "UTC" };

const snapshot: QuotaSnapshot = {
    v: 1,
    fetched_at: "2026-06-12T11:59:48.000Z",
    five_hour: { utilization: 88.0, resets_at: "2026-06-12T15:30:00.000Z" },
    seven_day: { utilization: 51.0, resets_at: "2026-06-15T21:00:00.000Z" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 4.0, resets_at: "2026-06-15T21:00:00.000Z" },
    extra_usage: { is_enabled: false, utilization: null, used_credits: null, monthly_limit: null },
};

// --- Spend-mode test snapshots -----------------------------------------------
// splurge = 7d near reset (<24h) + >25% remaining + no window >=80%
// NOW_MS = 2026-06-12T12:00:00Z; reset in 12h → 2026-06-12T00:00:00Z was 12h ago
// so a reset 12h from now = 2026-06-13T00:00:00Z = near reset
const splurgeSnapshot: QuotaSnapshot = {
    v: 1,
    fetched_at: new Date(NOW_MS - 30_000).toISOString(), // 30s ago → fresh
    five_hour: { utilization: 30, resets_at: "2026-06-12T20:00:00.000Z" },
    seven_day: { utilization: 50, resets_at: "2026-06-13T00:00:00.000Z" }, // 12h away → near reset
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
};

// conserve = 7d NOT near reset (reset far in future)
const conserveSnapshot: QuotaSnapshot = {
    v: 1,
    fetched_at: new Date(NOW_MS - 30_000).toISOString(), // 30s ago → fresh
    five_hour: { utilization: 30, resets_at: "2026-06-12T20:00:00.000Z" },
    seven_day: { utilization: 50, resets_at: "2026-06-19T00:00:00.000Z" }, // 7 days away → NOT near
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
};

// stale = fetched_at > 5min ago
const staleSnapshot: QuotaSnapshot = {
    v: 1,
    fetched_at: new Date(NOW_MS - 8 * 60_000).toISOString(), // 8 min ago → stale
    five_hour: { utilization: 30, resets_at: "2026-06-12T20:00:00.000Z" },
    seven_day: { utilization: 50, resets_at: "2026-06-13T00:00:00.000Z" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: null,
};

describe("fmtReset", () => {
    test("same-day reset is bare time", () => {
        expect(fmtReset("2026-06-12T15:30:00.000Z", UTC)).toBe("15:30");
    });
    test("later reset gains a weekday", () => {
        expect(fmtReset("2026-06-15T21:00:00.000Z", UTC)).toBe("Mon 21:00");
    });
    test("garbage is '?'", () => {
        expect(fmtReset("not-a-date", UTC)).toBe("?");
    });
});

describe("agoText", () => {
    test("seconds, minutes, hours", () => {
        expect(agoText("2026-06-12T11:59:48.000Z", NOW_MS)).toBe("12s ago");
        expect(agoText("2026-06-12T11:55:00.000Z", NOW_MS)).toBe("5m ago");
        expect(agoText("2026-06-12T09:00:00.000Z", NOW_MS)).toBe("3h ago");
    });
});

describe("renderStatusline", () => {
    test("compact 5h + 7d line", () => {
        expect(renderStatusline(snapshot, UTC)).toBe("5h 88% → 15:30 · 7d 51% · CONSERVE");
    });
    test("empty snapshot degrades", () => {
        expect(
            renderStatusline(
                { ...snapshot, five_hour: null, seven_day: null, seven_day_sonnet: null },
                UTC,
            ),
        ).toBe("quota n/a");
    });
    test("splurge snapshot → SPLURGE + /dojo nudge", () => {
        const out = renderStatusline(splurgeSnapshot, { nowMs: NOW_MS, timeZone: "UTC" });
        expect(out).toContain("SPLURGE");
        expect(out).toContain("/dojo");
    });
    test("conserve snapshot → CONSERVE, no /dojo", () => {
        const out = renderStatusline(conserveSnapshot, { nowMs: NOW_MS, timeZone: "UTC" });
        expect(out).toContain("CONSERVE");
        expect(out).not.toContain("/dojo");
    });
    test("stale snapshot → mode? (stale Nm)", () => {
        const out = renderStatusline(staleSnapshot, { nowMs: NOW_MS, timeZone: "UTC" });
        expect(out).toContain("stale");
        expect(out).toMatch(/\d+m/); // minutes
    });
});

describe("renderQuotaTable", () => {
    test("lists windows with resets and footer", () => {
        const out = renderQuotaTable(snapshot, { ...UTC, sourceNote: "live" });
        expect(out).toContain("5h            88%  15:30");
        expect(out).toContain("7d            51%  Mon 21:00");
        expect(out).toContain("7d sonnet      4%  Mon 21:00");
        expect(out).toContain("extra         off");
        expect(out).toContain("(fetched 12s ago, live)");
    });
    test("table shows spend mode for splurge snapshot", () => {
        const out = renderQuotaTable(splurgeSnapshot, { nowMs: NOW_MS, timeZone: "UTC", sourceNote: "cache" });
        expect(out).toContain("SPLURGE");
    });
    test("table shows spend mode for conserve snapshot", () => {
        const out = renderQuotaTable(conserveSnapshot, { nowMs: NOW_MS, timeZone: "UTC", sourceNote: "cache" });
        expect(out).toContain("CONSERVE");
    });
    test("table shows stale notice", () => {
        const out = renderQuotaTable(staleSnapshot, { nowMs: NOW_MS, timeZone: "UTC", sourceNote: "cache" });
        expect(out).toContain("stale");
    });
});

describe("renderSwiftBar", () => {
    test("title from 5h window, color at >=75 peak", () => {
        const out = renderSwiftBar(snapshot, UTC).split("\n");
        expect(out[0]).toBe("◕ 88% | color=orange");
        expect(out[1]).toBe("---");
        expect(out).toContain("5h: 88% - resets 15:30");
        expect(out).toContain("7d: 51% - resets Mon 21:00");
        expect(out).toContain("extra usage: off");
    });
    test("red at >=90", () => {
        const hot = {
            ...snapshot,
            five_hour: { utilization: 95, resets_at: "2026-06-12T15:30:00.000Z" },
        };
        expect(renderSwiftBar(hot, UTC).split("\n")[0]).toBe("● 95% | color=red");
    });
    test("no windows degrades", () => {
        const empty = {
            ...snapshot,
            five_hour: null,
            seven_day: null,
            seven_day_sonnet: null,
        };
        expect(renderSwiftBar(empty, UTC).split("\n")[0]).toBe("◌ quota n/a");
    });
});
