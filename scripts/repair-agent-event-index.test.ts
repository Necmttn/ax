import { describe, expect, test } from "bun:test";
import { planSessionDedup } from "./repair-agent-event-index.ts";

describe("planSessionDedup", () => {
    test("keeps the first row at each seq and drops the rest", () => {
        const drop = planSessionDedup([
            { id: "agent_event:a", seq: 1 },
            { id: "agent_event:b", seq: 2 },
            { id: "agent_event:c", seq: 2 }, // dup of seq 2 -> drop
            { id: "agent_event:d", seq: 3 },
            { id: "agent_event:e", seq: 3 }, // dup of seq 3 -> drop
            { id: "agent_event:f", seq: 3 }, // dup of seq 3 -> drop
        ]);
        expect(drop).toEqual(["agent_event:c", "agent_event:e", "agent_event:f"]);
    });

    test("a clean session drops nothing", () => {
        const drop = planSessionDedup([
            { id: "agent_event:a", seq: 1 },
            { id: "agent_event:b", seq: 2 },
            { id: "agent_event:c", seq: 3 },
        ]);
        expect(drop).toEqual([]);
    });

    test("empty input drops nothing", () => {
        expect(planSessionDedup([])).toEqual([]);
    });
});
