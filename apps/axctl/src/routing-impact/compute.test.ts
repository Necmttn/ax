import { describe, expect, test } from "bun:test";
import { buildImpactReport, type BlockInput } from "./compute.ts";

// utilization is 0-100 (matches the quota endpoint), so a delta is points directly.
const edge = (utilization: number, resets_at = "2026-06-19T20:00:00Z") => ({ utilization, resets_at });

const block = (over: Partial<BlockInput> & { arm: BlockInput["arm"] }): BlockInput => ({
    label: undefined,
    started_at: "2026-06-19T10:00:00Z",
    ended_at: "2026-06-19T15:00:00Z",
    fiveHourStart: edge(10),
    fiveHourEnd: edge(40),
    tokenCostUsd: 100,
    dispatchCount: 10,
    inheritCount: 5,
    turns: 300,
    ...over,
});

describe("buildImpactReport - single block", () => {
    test("computes window pp consumed, inherit %, and work-per-window", () => {
        const { blocks } = buildImpactReport([block({ arm: "off" })]);
        const b = blocks[0]!;
        expect(b.fiveHourPpConsumed).toBe(30); // 40 - 10
        expect(b.inheritPct).toBe(50); // 5/10
        expect(b.workPerWindowPp).toBe(10); // 300 turns / 30 pp
        expect(b.windowReset).toBe(false);
        expect(b.durationMin).toBe(300);
    });

    test("flags a window reset (resets_at changed) and omits the delta", () => {
        const { blocks, notes } = buildImpactReport([
            block({
                arm: "off",
                fiveHourStart: edge(80, "2026-06-19T20:00:00Z"),
                fiveHourEnd: edge(10, "2026-06-20T01:00:00Z"),
            }),
        ]);
        expect(blocks[0]!.windowReset).toBe(true);
        expect(blocks[0]!.fiveHourPpConsumed).toBeNull();
        expect(blocks[0]!.workPerWindowPp).toBeNull();
        expect(notes.some((n) => n.includes("reset"))).toBe(true);
    });

    test("flags a reset when utilization drops without a resets_at change", () => {
        const { blocks } = buildImpactReport([
            block({ arm: "off", fiveHourStart: edge(50), fiveHourEnd: edge(20) }),
        ]);
        expect(blocks[0]!.windowReset).toBe(true);
        expect(blocks[0]!.fiveHourPpConsumed).toBeNull();
    });

    test("null quota edges → no window delta, note emitted", () => {
        const { blocks, notes } = buildImpactReport([
            block({ arm: "off", fiveHourStart: null, fiveHourEnd: null }),
        ]);
        expect(blocks[0]!.fiveHourPpConsumed).toBeNull();
        expect(blocks[0]!.windowReset).toBe(false);
        expect(notes.some((n) => n.includes("unavailable"))).toBe(true);
    });

    test("zero dispatches → inheritPct null (no divide-by-zero)", () => {
        const { blocks } = buildImpactReport([block({ arm: "off", dispatchCount: 0, inheritCount: 0 })]);
        expect(blocks[0]!.inheritPct).toBeNull();
    });

    test("zero window consumed → workPerWindowPp null (no divide-by-zero)", () => {
        const { blocks } = buildImpactReport([
            block({ arm: "off", fiveHourStart: edge(30), fiveHourEnd: edge(30) }),
        ]);
        expect(blocks[0]!.fiveHourPpConsumed).toBe(0);
        expect(blocks[0]!.workPerWindowPp).toBeNull();
    });
});

describe("buildImpactReport - off vs on comparison", () => {
    test("computes the work-per-window ratio, cost ratio, inherit drop", () => {
        // off: 300 turns over 30pp → 10 work/pp, $100, 50% inherit
        // on:  300 turns over 15pp → 20 work/pp, $40,  10% inherit
        const { comparison } = buildImpactReport([
            block({ arm: "off" }),
            block({
                arm: "on",
                fiveHourStart: edge(10),
                fiveHourEnd: edge(25), // 15pp
                tokenCostUsd: 40,
                dispatchCount: 10,
                inheritCount: 1,
                turns: 300,
            }),
        ]);
        expect(comparison).not.toBeNull();
        expect(comparison!.workPerWindowRatio).toBe(2); // 20/10 → 2x more work per window
        expect(comparison!.costRatio).toBe(2.5); // 100/40
        expect(comparison!.inheritPctDrop).toBe(40); // 50 - 10
    });

    test("no comparison with only one arm", () => {
        const { comparison } = buildImpactReport([block({ arm: "off" })]);
        expect(comparison).toBeNull();
    });

    test("comparison ratio null when one side had a window reset", () => {
        const { comparison } = buildImpactReport([
            block({ arm: "off", fiveHourStart: edge(90), fiveHourEnd: edge(10) }), // reset
            block({ arm: "on" }),
        ]);
        expect(comparison!.workPerWindowRatio).toBeNull();
        // cost ratio still computable
        expect(comparison!.costRatio).not.toBeNull();
    });

    test("multiple blocks per arm → no comparison, note emitted", () => {
        const { comparison, notes } = buildImpactReport([
            block({ arm: "off" }),
            block({ arm: "off" }),
            block({ arm: "on" }),
        ]);
        expect(comparison).toBeNull();
        expect(notes.some((n) => n.includes("multiple blocks"))).toBe(true);
    });
});
