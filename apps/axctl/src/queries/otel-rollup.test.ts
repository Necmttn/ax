import { describe, expect, it } from "bun:test";
import {
    FLOWING_MS,
    STALE_MS,
    coveragePct,
    formatAge,
    healthGlyph,
    otelHealth,
} from "./otel-rollup.ts";
import { renderOtelRollup } from "../cli/commands/ax-otel.ts";
import type { OtelRollupResult } from "./otel-rollup.ts";

const NOW = Date.UTC(2026, 5, 25, 0, 0, 0); // 2026-06-25T00:00:00Z

describe("otelHealth", () => {
    it("is none when never observed", () => {
        expect(otelHealth(null, NOW)).toBe("none");
    });
    it("is none on an unparseable timestamp", () => {
        expect(otelHealth("not-a-date", NOW)).toBe("none");
    });
    it("is flowing under 6h", () => {
        expect(otelHealth(new Date(NOW - FLOWING_MS + 1).toISOString(), NOW)).toBe("flowing");
    });
    it("is stale between 6h and 48h", () => {
        expect(otelHealth(new Date(NOW - FLOWING_MS - 1).toISOString(), NOW)).toBe("stale");
        expect(otelHealth(new Date(NOW - STALE_MS + 1).toISOString(), NOW)).toBe("stale");
    });
    it("is cold past 48h", () => {
        expect(otelHealth(new Date(NOW - STALE_MS - 1).toISOString(), NOW)).toBe("cold");
    });
});

describe("healthGlyph", () => {
    it("maps each verdict", () => {
        expect(healthGlyph("flowing")).toBe("✓");
        expect(healthGlyph("stale")).toBe("⚠");
        expect(healthGlyph("cold")).toBe("✗");
        expect(healthGlyph("none")).toBe("·");
    });
});

describe("formatAge", () => {
    it("renders minutes, hours, days, never", () => {
        expect(formatAge(null)).toBe("never");
        expect(formatAge(-5)).toBe("0m");
        expect(formatAge(30 * 60_000)).toBe("30m");
        expect(formatAge(3 * 3_600_000)).toBe("3h");
        expect(formatAge(3 * 24 * 3_600_000)).toBe("3d");
    });
});

describe("coveragePct", () => {
    it("is 0 when no sessions", () => {
        expect(coveragePct(0, 0)).toBe(0);
        expect(coveragePct(5, 0)).toBe(0);
    });
    it("rounds to one decimal", () => {
        expect(coveragePct(1, 3)).toBe(33.3);
        expect(coveragePct(1, 2)).toBe(50);
    });
});

describe("renderOtelRollup", () => {
    const base: OtelRollupResult = {
        since_days: 14,
        generated_at: new Date(NOW).toISOString(),
        signals: [
            { harness: "claude", signal: "metric", count: 16700, last_observed_at: new Date(NOW - 2 * 24 * 3_600_000).toISOString(), age_ms: 2 * 24 * 3_600_000, health: "cold" },
        ],
        coverage: { window_sessions: 1501, linked_sessions: 0, pct: 0 },
        cost: { otlp_usd: 2542.99, transcript_usd: 20674.4 },
    };

    it("warns when telemetry arrives but correlation is 0%", () => {
        const out = renderOtelRollup(base);
        expect(out).toContain("0% is correlated");
        expect(out).toContain("claude/metric");
        expect(out).toContain("transcript");
    });

    it("does not warn when there is no telemetry at all", () => {
        const empty: OtelRollupResult = { ...base, signals: [], coverage: { window_sessions: 1501, linked_sessions: 0, pct: 0 } };
        const out = renderOtelRollup(empty);
        expect(out).toContain("no OTLP telemetry received");
        expect(out).not.toContain("0% is correlated");
    });

    it("does not warn when correlation is healthy", () => {
        const linked: OtelRollupResult = { ...base, coverage: { window_sessions: 1000, linked_sessions: 900, pct: 90 } };
        const out = renderOtelRollup(linked);
        expect(out).not.toContain("0% is correlated");
        expect(out).toContain("(90%)");
    });
});
