import { describe, expect, test } from "bun:test";
import { computeEstimate, formatDuration, formatDryRun, type DryRunResult } from "./dry-run.ts";

describe("computeEstimate", () => {
    test("projects ETA from a sampled rate", () => {
        // 30 sessions in 2s => 15/s; 1200 total => 80s.
        const { ratePerSec, etaSeconds } = computeEstimate(1200, 30, 2);
        expect(ratePerSec).toBeCloseTo(15, 5);
        expect(etaSeconds).toBe(80);
    });

    test("returns null when nothing was sampled (populated DB / watermark skip)", () => {
        expect(computeEstimate(1200, 0, 0)).toEqual({ ratePerSec: null, etaSeconds: null });
    });

    test("guards against a sub-10ms sample yielding an absurd rate", () => {
        expect(computeEstimate(1200, 30, 0.005)).toEqual({ ratePerSec: null, etaSeconds: null });
    });

    test("rounds ETA to whole seconds", () => {
        const { etaSeconds } = computeEstimate(100, 3, 1); // 3/s -> 33.33s
        expect(etaSeconds).toBe(33);
    });
});

describe("formatDuration", () => {
    test("seconds under a minute", () => {
        expect(formatDuration(45)).toBe("45s");
        expect(formatDuration(0)).toBe("0s");
    });
    test("minutes with zero-padded seconds", () => {
        expect(formatDuration(210)).toBe("3m30s");
        expect(formatDuration(65)).toBe("1m05s");
    });
    test("hours with zero-padded minutes", () => {
        expect(formatDuration(3720)).toBe("1h02m");
    });
});

const baseResult = (over: Partial<DryRunResult> = {}): DryRunResult => ({
    sources: { claude: 1180, codex: 60, pi: 0, opencodeStore: false, cursorStore: false, sessionsTotal: 1240 },
    sampled: { items: 30, seconds: 2.1 },
    ratePerSec: 14.3,
    etaSeconds: 210,
    ...over,
});

describe("formatDryRun", () => {
    test("json emits the machine-readable shape", () => {
        const out = JSON.parse(formatDryRun(baseResult(), true));
        expect(out.sources.sessionsTotal).toBe(1240);
        expect(out.etaSeconds).toBe(210);
        expect(out.ratePerSec).toBe(14.3);
        expect(out.sampled.items).toBe(30);
    });

    test("human output shows per-source counts, total, and ETA", () => {
        const out = formatDryRun(baseResult(), false);
        expect(out).toContain("claude   1,180 sessions");
        expect(out).toContain("codex    60 sessions");
        expect(out).not.toContain("pi "); // zero-count sources omitted
        expect(out).toContain("ETA ~3m30s");
        expect(out).toContain("ax serve");
    });

    test("human output handles an empty source set", () => {
        const out = formatDryRun(
            baseResult({
                sources: { claude: 0, codex: 0, pi: 0, opencodeStore: false, cursorStore: false, sessionsTotal: 0 },
                sampled: { items: 0, seconds: 0 },
                ratePerSec: null,
                etaSeconds: null,
            }),
            false,
        );
        expect(out).toContain("nothing to ingest yet");
    });

    test("human output handles an already-populated DB (no measurable rate)", () => {
        const out = formatDryRun(baseResult({ ratePerSec: null, etaSeconds: null }), false);
        expect(out).toContain("already has data");
        expect(out).toContain("ax ingest");
    });
});
