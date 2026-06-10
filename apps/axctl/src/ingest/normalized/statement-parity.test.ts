import { describe, expect, it } from "bun:test";
import { diffStatementSets } from "./statement-parity.ts";

describe("diffStatementSets", () => {
    it("reports empty deltas for equal multisets regardless of order", () => {
        expect(diffStatementSets(["a;", "b;", "b;"], ["b;", "a;", "b;"]))
            .toEqual({ missing: [], added: [] });
    });

    it("reports statements only in legacy as missing and only in next as added", () => {
        expect(diffStatementSets(["a;", "b;"], ["a;", "c;"]))
            .toEqual({ missing: ["b;"], added: ["c;"] });
    });

    it("respects multiplicity", () => {
        expect(diffStatementSets(["a;", "a;"], ["a;"]))
            .toEqual({ missing: ["a;"], added: [] });
    });
});
