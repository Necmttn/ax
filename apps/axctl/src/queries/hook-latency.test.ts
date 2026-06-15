/**
 * Tests for hook-latency.ts: regression lens over hook_command_invocation.duration_ms.
 */
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Layer } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { makeTestSurrealClient } from "@ax/lib/testing/surreal";

import {
    fetchHookLatencyRegression,
    computeHookLatency,
    renderHookLatency,
    type HookLatencyReport,
    type HookLatencyRow,
} from "./hook-latency.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const run = <A>(eff: Effect.Effect<A, unknown, SurrealClient>, layer: Layer.Layer<SurrealClient>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)));

/** Build a test layer routing the hook latency query to given rows. */
const makeLatencyMock = (rawRows: unknown[]) => {
    const tc = makeTestSurrealClient({
        denyWrites: true,
        fallback: [rawRows],
    });
    return tc;
};

/**
 * Build a synthetic ISO timestamp that is `offsetMs` milliseconds ago from now.
 */
const ago = (offsetMs: number): string => new Date(Date.now() - offsetMs).toISOString();

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// computeHookLatency (pure, unit tests)
// ---------------------------------------------------------------------------

describe("computeHookLatency", () => {
    const baseOpts = { recentDays: 7, baselineDays: 21, factor: 1.5, minDeltaMs: 15, minSamples: 5 };

    it("flags a hook as regressed when recent p95 is much higher than baseline", () => {
        // 10 baseline fires at ~50ms, 10 recent fires at ~200ms
        const rows = [
            // baseline: 21+7=28 days ago .. 7 days ago
            ...Array.from({ length: 10 }, (_, i) => ({
                hook_name: "slow-hook",
                ts: ago((8 + i) * DAY_MS), // 8-17 days ago (in baseline window)
                duration_ms: 50 + i,
            })),
            // recent: last 7 days
            ...Array.from({ length: 10 }, (_, i) => ({
                hook_name: "slow-hook",
                ts: ago((i + 1) * DAY_MS * 0.5), // 0.5-5 days ago (in recent window)
                duration_ms: 200 + i,
            })),
        ];
        const result = computeHookLatency(rows, baseOpts);
        expect(result).toHaveLength(1);
        const row = result[0]!;
        expect(row.hook_name).toBe("slow-hook");
        expect(row.regressed).toBe(true);
        expect(row.recent.samples).toBe(10);
        expect(row.baseline.samples).toBe(10);
        expect(row.recent.p95).toBeGreaterThan(row.baseline.p95);
        expect(row.p95_delta_ms).toBe(row.recent.p95 - row.baseline.p95);
        expect(row.p95_ratio).toBeGreaterThan(0);
    });

    it("does NOT flag a hook below minSamples even if slower", () => {
        // Only 3 recent fires (below minSamples=5)
        const rows = [
            ...Array.from({ length: 5 }, (_, i) => ({
                hook_name: "sparse-hook",
                ts: ago((8 + i) * DAY_MS),
                duration_ms: 50,
            })),
            ...Array.from({ length: 3 }, (_, i) => ({
                hook_name: "sparse-hook",
                ts: ago((i + 1) * DAY_MS * 0.5),
                duration_ms: 300, // much slower, but only 3 samples
            })),
        ];
        const result = computeHookLatency(rows, baseOpts);
        expect(result).toHaveLength(1);
        expect(result[0]!.regressed).toBe(false);
    });

    it("does NOT flag a stable hook (similar p95)", () => {
        const rows = [
            ...Array.from({ length: 10 }, (_, i) => ({
                hook_name: "stable-hook",
                ts: ago((8 + i) * DAY_MS),
                duration_ms: 80 + i,
            })),
            ...Array.from({ length: 10 }, (_, i) => ({
                hook_name: "stable-hook",
                ts: ago((i + 1) * DAY_MS * 0.5),
                duration_ms: 82 + i, // negligible difference
            })),
        ];
        const result = computeHookLatency(rows, baseOpts);
        expect(result[0]!.regressed).toBe(false);
    });

    it("sorts: regressed first, then p95_delta_ms desc", () => {
        const regressedRows = Array.from({ length: 10 }, (_, i) => ({
            hook_name: "a-regressed",
            ts: ago((8 + i) * DAY_MS),
            duration_ms: 50,
        })).concat(Array.from({ length: 10 }, (_, i) => ({
            hook_name: "a-regressed",
            ts: ago((i + 1) * 12 * 3600 * 1000),
            duration_ms: 200,
        })));
        const stableRows = Array.from({ length: 10 }, (_, i) => ({
            hook_name: "b-stable",
            ts: ago((8 + i) * DAY_MS),
            duration_ms: 80,
        })).concat(Array.from({ length: 10 }, (_, i) => ({
            hook_name: "b-stable",
            ts: ago((i + 1) * 12 * 3600 * 1000),
            duration_ms: 82,
        })));
        const result = computeHookLatency([...stableRows, ...regressedRows], baseOpts);
        expect(result[0]!.hook_name).toBe("a-regressed");
        expect(result[0]!.regressed).toBe(true);
    });

    it("a fire exactly at the recent/baseline boundary lands in baseline (<=)", () => {
        // A ts that is exactly now - recentDays·d should be in baseline (not recent)
        const exactCutoff = new Date(Date.now() - baseOpts.recentDays * DAY_MS);
        const rows = [
            // The boundary fire - exactly at recentCutoffMs. Since `isRecent` uses strict >,
            // this ts == recentCutoffMs so it is NOT recent and falls into baseline.
            {
                hook_name: "boundary-hook",
                ts: exactCutoff.toISOString(),
                duration_ms: 100,
            },
            // Extra baseline fires so the bucket appears
            ...Array.from({ length: 4 }, (_, i) => ({
                hook_name: "boundary-hook",
                ts: ago((8 + i) * DAY_MS),
                duration_ms: 100,
            })),
        ];
        const result = computeHookLatency(rows, { ...baseOpts, minSamples: 1 });
        expect(result).toHaveLength(1);
        const row = result[0]!;
        // The boundary fire is in baseline (total baseline = 5), recent = 0
        expect(row.baseline.samples).toBe(5);
        expect(row.recent.samples).toBe(0);
    });

    it("excludes rows that are neither in recent nor baseline window", () => {
        // 40 days ago - outside the totalDays=28 window
        const rows = [
            {
                hook_name: "old-hook",
                ts: ago(40 * DAY_MS),
                duration_ms: 50,
            },
        ];
        const result = computeHookLatency(rows, baseOpts);
        // The row is filtered out (outside both windows)
        expect(result).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// renderHookLatency (pure, unit tests)
// ---------------------------------------------------------------------------

describe("renderHookLatency", () => {
    it("empty-state when total_fires_with_latency is 0", () => {
        const report: HookLatencyReport = {
            recent_days: 7,
            baseline_days: 21,
            rows: [],
            total_fires_with_latency: 0,
        };
        const output = renderHookLatency(report);
        expect(output).toContain("no hook latency telemetry in this window");
        expect(output).toContain("duration_ms");
        expect(output).toContain("ax hooks bench");
    });

    it("regressed row shows ⚠", () => {
        const row: HookLatencyRow = {
            hook_name: "slow-hook",
            recent: { p50: 150, p95: 300, samples: 25 },
            baseline: { p50: 60, p95: 80, samples: 25 },
            p95_delta_ms: 220,
            p95_ratio: 3.75,
            regressed: true,
        };
        const report: HookLatencyReport = {
            recent_days: 7,
            baseline_days: 21,
            rows: [row],
            total_fires_with_latency: 50,
        };
        const output = renderHookLatency(report);
        expect(output).toContain("⚠");
        expect(output).toContain("slow-hook");
        expect(output).toContain("1 regressed / 1 hooks");
    });

    it("non-regressed row does NOT show ⚠", () => {
        const row: HookLatencyRow = {
            hook_name: "fast-hook",
            recent: { p50: 70, p95: 85, samples: 25 },
            baseline: { p50: 65, p95: 80, samples: 25 },
            p95_delta_ms: 5,
            p95_ratio: 1.06,
            regressed: false,
        };
        const report: HookLatencyReport = {
            recent_days: 7,
            baseline_days: 21,
            rows: [row],
            total_fires_with_latency: 50,
        };
        const output = renderHookLatency(report);
        // The ⚠ column header appears but the row's warn cell is empty
        expect(output).toContain("fast-hook");
        expect(output).toContain("0 regressed / 1 hooks");
        // The warning ⚠ should only appear in the header row
        const lines = output.split("\n");
        const hookLine = lines.find((l) => l.includes("fast-hook"));
        // trim trailing spaces; the warn column for non-regressed is empty string
        expect(hookLine?.trimEnd()).not.toMatch(/⚠\s*$/);
    });
});

// ---------------------------------------------------------------------------
// fetchHookLatencyRegression (DB-stub integration tests)
// ---------------------------------------------------------------------------

describe("fetchHookLatencyRegression", () => {
    it("two hooks: one regressed, one stable → correct flags, delta, ratio, sort order", async () => {
        // slow-hook: baseline ~50ms p95, recent ~300ms p95 → regressed
        // fast-hook: baseline ~80ms p95, recent ~85ms p95 → stable
        const baselineTs = (i: number) => ago((8 + i) * DAY_MS);
        const recentTs = (i: number) => ago((i + 1) * 12 * 3600 * 1000); // 0.5-12h ago

        const rawRows = [
            // slow-hook baseline (25 fires at 40-65ms)
            ...Array.from({ length: 25 }, (_, i) => ({
                hook_name: "slow-hook",
                ts: baselineTs(i % 10),
                duration_ms: 40 + i,
            })),
            // slow-hook recent (25 fires at 200-300ms)
            ...Array.from({ length: 25 }, (_, i) => ({
                hook_name: "slow-hook",
                ts: recentTs(i % 10),
                duration_ms: 200 + i * 4,
            })),
            // fast-hook baseline (25 fires at 70-80ms)
            ...Array.from({ length: 25 }, (_, i) => ({
                hook_name: "fast-hook",
                ts: baselineTs(i % 10),
                duration_ms: 70 + (i % 10),
            })),
            // fast-hook recent (25 fires at 72-82ms - negligible change)
            ...Array.from({ length: 25 }, (_, i) => ({
                hook_name: "fast-hook",
                ts: recentTs(i % 10),
                duration_ms: 72 + (i % 10),
            })),
        ];

        const tc = makeLatencyMock(rawRows);
        const result = await run(
            fetchHookLatencyRegression({ recentDays: 7, baselineDays: 21, minSamples: 20 }),
            tc.layer,
        );

        expect(result.total_fires_with_latency).toBe(100);
        expect(result.rows).toHaveLength(2);

        // regressed-first sort
        expect(result.rows[0]!.hook_name).toBe("slow-hook");
        expect(result.rows[0]!.regressed).toBe(true);
        expect(result.rows[0]!.p95_delta_ms).toBeGreaterThan(100);
        expect(result.rows[0]!.p95_ratio).toBeGreaterThan(1.5);

        expect(result.rows[1]!.hook_name).toBe("fast-hook");
        expect(result.rows[1]!.regressed).toBe(false);
    });

    it("hook below minSamples is NOT flagged even if p95 is higher", async () => {
        const rawRows = [
            // only 3 recent fires (below minSamples=20)
            ...Array.from({ length: 20 }, (_, i) => ({
                hook_name: "sparse-hook",
                ts: ago((8 + i % 10) * DAY_MS),
                duration_ms: 50,
            })),
            ...Array.from({ length: 3 }, (_, i) => ({
                hook_name: "sparse-hook",
                ts: ago((i + 1) * 12 * 3600 * 1000),
                duration_ms: 500,
            })),
        ];

        const tc = makeLatencyMock(rawRows);
        const result = await run(
            fetchHookLatencyRegression({ recentDays: 7, baselineDays: 21 }),
            tc.layer,
        );
        expect(result.rows[0]!.regressed).toBe(false);
        expect(result.rows[0]!.recent.samples).toBe(3);
    });

    it("returns empty rows (not error) when total_fires_with_latency is 0", async () => {
        const tc = makeLatencyMock([]);
        const result = await run(
            fetchHookLatencyRegression({ recentDays: 7, baselineDays: 21 }),
            tc.layer,
        );
        expect(result.total_fires_with_latency).toBe(0);
        expect(result.rows).toHaveLength(0);
    });

    it("duration_ms NONE rows are excluded by the WHERE clause (stub reflects this)", async () => {
        // Stub only returns rows WITHOUT duration_ms=NONE (the WHERE filters them DB-side).
        // We verify that a stub with valid rows still counts correctly.
        const rawRows = [
            { hook_name: "test-hook", ts: ago(1 * DAY_MS * 0.5), duration_ms: 100 },
            { hook_name: "test-hook", ts: ago(10 * DAY_MS), duration_ms: 80 },
        ];
        const tc = makeLatencyMock(rawRows);
        const result = await run(
            fetchHookLatencyRegression({ recentDays: 7, baselineDays: 21 }),
            tc.layer,
        );
        // Both valid rows counted
        expect(result.total_fires_with_latency).toBe(2);
    });
});
