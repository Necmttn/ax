import { describe, expect, test } from "bun:test";
import { buildTimeWarp } from "./StoryStrip.tsx";

// Helper: check that pct is monotonically non-decreasing over a set of timestamps
function isMonotonic(pct: (ts: number) => number, samples: number[]): boolean {
    let prev = -Infinity;
    for (const s of samples) {
        const v = pct(s);
        if (v < prev - 1e-9) return false;
        prev = v;
    }
    return true;
}

describe("buildTimeWarp", () => {
    test("degenerate: t1 <= t0 returns everything at 0", () => {
        const { segments, pct, compressedMs } = buildTimeWarp([], 1000, 500);
        expect(segments).toHaveLength(0);
        expect(pct(750)).toBe(0);
        expect(pct(1000)).toBe(0);
        expect(compressedMs).toBe(0);

        // t1 === t0
        const { pct: pct2 } = buildTimeWarp([1000], 1000, 1000);
        expect(pct2(1000)).toBe(0);
    });

    test("no anchors beyond t0/t1: single segment, no compression", () => {
        const t0 = 0;
        const t1 = 3_600_000; // 1h
        const { segments, pct, compressedMs } = buildTimeWarp([], t0, t1);
        expect(compressedMs).toBe(0);
        // Single segment spanning full axis
        expect(segments).toHaveLength(1);
        expect(segments[0]!.compressed).toBe(false);
        expect(pct(t0)).toBeCloseTo(0);
        expect(pct(t1)).toBeCloseTo(100);
        expect(pct((t0 + t1) / 2)).toBeCloseTo(50);
    });

    test("single long gap compressed to ~2% warp width", () => {
        // Session 1 hour, activity at 0 and at 58m, nothing in between
        const t0 = 0;
        const t1 = 3_600_000; // 1h
        const act1 = 0;          // event at t0
        const act2 = 58 * 60_000; // event at 58m
        // Gap between act1→act2 is 58m out of 60m = 96.7% > 8% → compressed
        // Gap between act2→t1 is 2m out of 60m = 3.3% < 8% → active

        const { segments, pct, compressedMs } = buildTimeWarp([act1, act2], t0, t1);

        // Should have compressed segments
        const compressed = segments.filter((s) => s.compressed);
        expect(compressed.length).toBeGreaterThan(0);

        // compressedMs should be the 58m gap
        expect(compressedMs).toBeCloseTo(58 * 60_000, -3);

        // The compressed segment warp width should be ~2% (compressedShare * 100)
        for (const seg of compressed) {
            const warpWidth = seg.warpEnd - seg.warpStart;
            expect(warpWidth).toBeCloseTo(2, 0); // within 1%
        }

        // pct is monotonic
        const samples = [t0, act1, act2 / 2, act2, (act2 + t1) / 2, t1];
        expect(isMonotonic(pct, samples)).toBe(true);
    });

    test("active segments split remaining space proportionally", () => {
        const t0 = 0;
        const t1 = 10_000; // 10 seconds total

        // Two active bursts with a large gap in the middle
        // burst1: 0..500ms (5% of real time, but small)
        // gap: 500ms..9000ms (85% → compressed since > 8%)
        // burst2: 9000ms..10000ms (10% of real time)

        const { segments, pct } = buildTimeWarp([500, 9000], t0, t1);

        const active = segments.filter((s) => !s.compressed);
        const compressed = segments.filter((s) => s.compressed);

        // One compressed gap
        expect(compressed.length).toBeGreaterThanOrEqual(1);

        // Active segments should exist
        expect(active.length).toBeGreaterThanOrEqual(1);

        // Total warp space for active = 100 - 2*numCompressed
        const totalActiveWarp = active.reduce((sum, s) => sum + (s.warpEnd - s.warpStart), 0);
        const expectedActiveWarp = 100 - compressed.length * 2;
        expect(totalActiveWarp).toBeCloseTo(expectedActiveWarp, 1);

        // pct at t0 = 0, pct at t1 = 100
        expect(pct(t0)).toBeCloseTo(0, 1);
        expect(pct(t1)).toBeCloseTo(100, 1);

        // pct is monotonic
        const samples = [0, 250, 500, 4750, 9000, 9500, 10000];
        expect(isMonotonic(pct, samples)).toBe(true);
    });

    test("pct is monotonic over many anchors", () => {
        const t0 = Date.now();
        const t1 = t0 + 7_200_000; // 2h session

        // Scattered activity: bursts at start and end with long idle in middle
        const anchors = [
            t0 + 60_000,
            t0 + 120_000,
            t0 + 180_000,
            // 3h gap (compressed)
            t0 + 6_900_000,
            t0 + 6_960_000,
            t0 + 7_020_000,
        ];

        const { pct } = buildTimeWarp(anchors, t0, t1);

        const samples: number[] = [];
        for (let i = 0; i <= 20; i++) {
            samples.push(t0 + (i / 20) * (t1 - t0));
        }
        expect(isMonotonic(pct, samples)).toBe(true);
    });

    test("compressedMs sums all idle gaps", () => {
        const t0 = 0;
        const t1 = 10_000_000; // 10,000 seconds

        // Two large gaps
        // active: 0..1000 (1% - active, small)
        // gap1: 1000..5000000 (50% > 8% → compressed)
        // active: 5000000..5001000 (tiny)
        // gap2: 5001000..9000000 (40% > 8% → compressed)
        // active: 9000000..10000000 (10%)

        const anchors = [1000, 5_000_000, 5_001_000, 9_000_000];
        const { compressedMs, segments } = buildTimeWarp(anchors, t0, t1);

        const compressed = segments.filter((s) => s.compressed);
        const manualSum = compressed.reduce((sum, s) => sum + (s.realEnd - s.realStart), 0);
        expect(compressedMs).toBe(manualSum);
        expect(compressedMs).toBeGreaterThan(0);
    });

    test("no compression when all gaps are short", () => {
        const t0 = 0;
        const t1 = 10_000;
        // 20 anchors spread every 500ms over 10s → each gap is 500/10000 = 5% < 8%, none compressed
        const anchors: number[] = [];
        for (let i = 1; i <= 19; i++) anchors.push(i * 500);
        const { compressedMs, segments } = buildTimeWarp(anchors, t0, t1);
        expect(compressedMs).toBe(0);
        expect(segments.every((s) => !s.compressed)).toBe(true);
    });
});
