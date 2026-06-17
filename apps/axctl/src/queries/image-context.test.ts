import { describe, expect, test } from "bun:test";
import { rollupImageContext } from "./image-context.ts";
import { BYTES_PER_TOKEN } from "./content-types.ts";

describe("rollupImageContext", () => {
    test("splits sessions by main vs subagent", () => {
        const rows = [
            { sid: "session:main1", calls: 2, bytes: 1000 },
            { sid: "session:sub1", calls: 1, bytes: 500 },
        ];
        const subagentSet = new Set(["session:sub1"]);
        const result = rollupImageContext(rows, subagentSet, 10);

        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toMatchObject({ session: "session:main1", origin: "main", calls: 2, bytes: 1000 });
        expect(result.rows[1]).toMatchObject({ session: "session:sub1", origin: "subagent", calls: 1, bytes: 500 });
    });

    test("totals are computed independently of limit", () => {
        const rows = [
            { sid: "session:a", calls: 3, bytes: 2000 },
            { sid: "session:b", calls: 1, bytes: 800 },
            { sid: "session:c", calls: 2, bytes: 400 },
        ];
        const subagentSet = new Set(["session:b"]);
        const result = rollupImageContext(rows, subagentSet, 1); // limit=1 caps rows

        // Only 1 row returned but totals reflect all input
        expect(result.rows).toHaveLength(1);
        expect(result.totals.mainBytes).toBe(2000 + 400); // a + c
        expect(result.totals.mainCalls).toBe(3 + 2);      // a + c
        expect(result.totals.subagentBytes).toBe(800);    // b
        expect(result.totals.subagentCalls).toBe(1);      // b
    });

    test("sorts main by bytes desc then subagent by bytes desc, main first", () => {
        const rows = [
            { sid: "session:sub-big", calls: 5, bytes: 9000 },
            { sid: "session:main-small", calls: 1, bytes: 100 },
            { sid: "session:main-big", calls: 4, bytes: 5000 },
            { sid: "session:sub-small", calls: 2, bytes: 200 },
        ];
        const subagentSet = new Set(["session:sub-big", "session:sub-small"]);
        const result = rollupImageContext(rows, subagentSet, 100);

        const ids = result.rows.map((r) => r.session);
        // main rows come first sorted by bytes desc, then subagent rows sorted by bytes desc
        expect(ids).toEqual([
            "session:main-big",
            "session:main-small",
            "session:sub-big",
            "session:sub-small",
        ]);
    });

    test("computes estTokens as bytes / BYTES_PER_TOKEN", () => {
        const rows = [{ sid: "session:x", calls: 1, bytes: 400 }];
        const result = rollupImageContext(rows, new Set(), 10);
        expect(result.rows[0].estTokens).toBe(400 / BYTES_PER_TOKEN);
        expect(BYTES_PER_TOKEN).toBe(4); // guard against drift
    });

    test("handles empty input", () => {
        const result = rollupImageContext([], new Set(), 10);
        expect(result.rows).toHaveLength(0);
        expect(result.totals).toEqual({ mainBytes: 0, mainCalls: 0, subagentBytes: 0, subagentCalls: 0 });
    });
});
