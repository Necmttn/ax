import { describe, expect, test } from "bun:test";
import { correctedInvokedTurnKeys, skillPairedEdgeId } from "./core.ts";

describe("signal row identities", () => {
    test("corrections return stable keys for corrected turn positions", () => {
        const keys = correctedInvokedTurnKeys([
            { fromTurnKey: "a", toTurnKey: "b", pattern: "no", text: "no", ts: "2026-01-01", repositoryKey: null, checkoutKey: null, cwd: null, correctedSession: "s", correctedSeq: 1 },
            { fromTurnKey: "a", toTurnKey: "c", pattern: "wrong", text: "wrong", ts: "2026-01-02", repositoryKey: null, checkoutKey: null, cwd: null, correctedSession: "s", correctedSeq: 2 },
        ]);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toContain("seq_000001");
        expect(keys[1]).toContain("seq_000002");
    });

    test("skill pair identity is order independent", () => {
        expect(skillPairedEdgeId("skill:a", "skill:b"))
            .toEqual(skillPairedEdgeId("skill:b", "skill:a"));
    });
});
