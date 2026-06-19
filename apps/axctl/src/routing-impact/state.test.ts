import { describe, expect, test } from "bun:test";
import {
    EMPTY_STATE,
    beginBlock,
    endBlock,
    openBlock,
    completedBlocks,
    RoutingImpactStateError,
    type RoutingImpactState,
} from "./state.ts";

const edge = { utilization: 0.2, resets_at: "2026-06-19T20:00:00Z" };

describe("routing-impact state transitions", () => {
    test("begin appends an open block", () => {
        const s = beginBlock(EMPTY_STATE, { arm: "off", startedAt: "t0", fiveHour: edge });
        expect(s).not.toBeInstanceOf(RoutingImpactStateError);
        const state = s as RoutingImpactState;
        expect(state.blocks).toHaveLength(1);
        expect(openBlock(state)?.arm).toBe("off");
        expect(openBlock(state)?.ended_at).toBeNull();
    });

    test("begin twice without end fails", () => {
        const s1 = beginBlock(EMPTY_STATE, { arm: "off", startedAt: "t0", fiveHour: edge }) as RoutingImpactState;
        const s2 = beginBlock(s1, { arm: "on", startedAt: "t1", fiveHour: edge });
        expect(s2).toBeInstanceOf(RoutingImpactStateError);
        expect((s2 as RoutingImpactStateError).reason).toContain("still running");
    });

    test("end closes the open block with the end edge", () => {
        const s1 = beginBlock(EMPTY_STATE, { arm: "off", startedAt: "t0", fiveHour: edge }) as RoutingImpactState;
        const endEdge = { utilization: 0.5, resets_at: "2026-06-19T20:00:00Z" };
        const s2 = endBlock(s1, { endedAt: "t1", fiveHour: endEdge }) as RoutingImpactState;
        expect(openBlock(s2)).toBeNull();
        expect(completedBlocks(s2)).toHaveLength(1);
        expect(completedBlocks(s2)[0]!.five_hour_end).toEqual(endEdge);
        expect(completedBlocks(s2)[0]!.ended_at).toBe("t1");
    });

    test("end with no open block fails", () => {
        const s = endBlock(EMPTY_STATE, { endedAt: "t1", fiveHour: edge });
        expect(s).toBeInstanceOf(RoutingImpactStateError);
        expect((s as RoutingImpactStateError).reason).toContain("no open block");
    });

    test("full off→on cycle yields two completed blocks", () => {
        let s = beginBlock(EMPTY_STATE, { arm: "off", startedAt: "a", fiveHour: edge }) as RoutingImpactState;
        s = endBlock(s, { endedAt: "b", fiveHour: edge }) as RoutingImpactState;
        s = beginBlock(s, { arm: "on", startedAt: "c", fiveHour: edge }) as RoutingImpactState;
        s = endBlock(s, { endedAt: "d", fiveHour: edge }) as RoutingImpactState;
        expect(completedBlocks(s)).toHaveLength(2);
        expect(completedBlocks(s).map((b) => b.arm)).toEqual(["off", "on"]);
    });

    test("label is carried when provided", () => {
        const s = beginBlock(EMPTY_STATE, { arm: "on", label: "tuesday", startedAt: "t0", fiveHour: edge }) as RoutingImpactState;
        expect(openBlock(s)?.label).toBe("tuesday");
    });

    test("null quota edge is allowed (quota unavailable at capture)", () => {
        const s = beginBlock(EMPTY_STATE, { arm: "off", startedAt: "t0", fiveHour: null }) as RoutingImpactState;
        expect(openBlock(s)?.five_hour_start).toBeNull();
    });
});
