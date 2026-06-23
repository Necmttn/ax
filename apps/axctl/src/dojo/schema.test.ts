// apps/axctl/src/dojo/schema.test.ts
import { describe, expect, test } from "bun:test";
import { compareByPriority, KIND_PRIORITY } from "./schema.ts";

describe("KIND_PRIORITY", () => {
    test("orders kinds per spec (cheap + high-signal first)", () => {
        expect(KIND_PRIORITY).toEqual([
            "verdict_pending",
            "brief_unfilled",
            "directives",
            "routing_backtest",
            "proposal_mint",
            "experiment",
            "upstream_draft",
            "spar",
            "explore",
        ]);
    });

    test("compareByPriority sorts items by kind order, stable within kind", () => {
        const items = [
            { id: "b", kind: "experiment" },
            { id: "a", kind: "verdict_pending" },
            { id: "c", kind: "verdict_pending" },
        ] as const;
        const sorted = [...items].sort(compareByPriority);
        expect(sorted.map((i) => i.id)).toEqual(["a", "c", "b"]);
    });
});
