import { describe, expect, test } from "bun:test";
import { computeDownstreamShares } from "./downstream.ts";

// Helper: invocation event
const inv = (session: string, skill: string, ts: string) => ({ session, skill, ts });
// Helper: session row
const sess = (id: string, s: string, e: string) => ({ id, s, e });

describe("computeDownstreamShares", () => {
    test("returns empty map with no data", () => {
        const result = computeDownstreamShares([], []);
        expect(result.size).toBe(0);
    });

    test("skill fires early -> high share", () => {
        // Session: 60min duration; skill fires at +1min -> ~98% remaining
        const invocations = [inv("s1", "tdd", "2026-06-13T10:01:00Z")];
        const sessions = [sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T11:00:00Z")];
        const result = computeDownstreamShares(invocations, sessions);
        const share = result.get("tdd");
        expect(share).toBeDefined();
        expect(share!).toBeGreaterThan(0.9);
        expect(share!).toBeLessThanOrEqual(1.0);
    });

    test("skill fires late -> low share", () => {
        // Session: 60min; skill fires at +55min -> ~8% remaining
        const invocations = [inv("s1", "tdd", "2026-06-13T10:55:00Z")];
        const sessions = [sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T11:00:00Z")];
        const result = computeDownstreamShares(invocations, sessions);
        const share = result.get("tdd")!;
        expect(share).toBeLessThan(0.2);
        expect(share).toBeGreaterThanOrEqual(0);
    });

    test("averages across multiple sessions", () => {
        // Session 1: 60min, fires at +1min (share ~0.983)
        // Session 2: 60min, fires at +59min (share ~0.017)
        // Average ~0.5
        const invocations = [
            inv("s1", "tdd", "2026-06-13T10:01:00Z"),
            inv("s2", "tdd", "2026-06-13T11:59:00Z"),
        ];
        const sessions = [
            sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T11:00:00Z"),
            sess("s2", "2026-06-13T11:00:00Z", "2026-06-13T12:00:00Z"),
        ];
        const result = computeDownstreamShares(invocations, sessions);
        const share = result.get("tdd")!;
        expect(share).toBeCloseTo(0.5, 1);
    });

    test("skips sessions < 5min duration", () => {
        // Session: 4 min - should be excluded
        const invocations = [inv("s1", "tdd", "2026-06-13T10:01:00Z")];
        const sessions = [sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T10:04:00Z")];
        const result = computeDownstreamShares(invocations, sessions);
        expect(result.get("tdd")).toBeUndefined();
    });

    test("skips sessions without timestamps", () => {
        const invocations = [inv("s1", "tdd", "2026-06-13T10:01:00Z")];
        const sessions = [sess("s1", "null", "null")];
        const result = computeDownstreamShares(invocations, sessions);
        expect(result.get("tdd")).toBeUndefined();
    });

    test("clamps result to [0, 1]", () => {
        // Invocation before session start -> share clamped to 1
        const invocations = [inv("s1", "tdd", "2026-06-13T09:59:00Z")];
        const sessions = [sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T11:00:00Z")];
        const result = computeDownstreamShares(invocations, sessions);
        const share = result.get("tdd")!;
        expect(share).toBe(1.0);
    });

    test("uses first invocation per session when skill fires multiple times", () => {
        // Fires at +2min and +58min; should use +2min (early = high share)
        const invocations = [
            inv("s1", "tdd", "2026-06-13T10:02:00Z"),
            inv("s1", "tdd", "2026-06-13T10:58:00Z"),
        ];
        const sessions = [sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T11:00:00Z")];
        const result = computeDownstreamShares(invocations, sessions);
        const share = result.get("tdd")!;
        // +2min of 60min -> (60-2)/60 = 0.967
        expect(share).toBeGreaterThan(0.9);
    });

    test("rounds to 2 decimal places", () => {
        const invocations = [inv("s1", "tdd", "2026-06-13T10:01:00Z")];
        const sessions = [sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T11:00:00Z")];
        const result = computeDownstreamShares(invocations, sessions);
        const share = result.get("tdd")!;
        expect(Number(share.toFixed(2))).toBe(share);
    });

    test("multiple skills computed independently", () => {
        const invocations = [
            inv("s1", "tdd", "2026-06-13T10:01:00Z"),  // early
            inv("s1", "plan", "2026-06-13T10:55:00Z"), // late
        ];
        const sessions = [sess("s1", "2026-06-13T10:00:00Z", "2026-06-13T11:00:00Z")];
        const result = computeDownstreamShares(invocations, sessions);
        expect(result.get("tdd")!).toBeGreaterThan(0.9);
        expect(result.get("plan")!).toBeLessThan(0.2);
    });
});
