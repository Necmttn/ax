import { describe, expect, test } from "bun:test";
import { findVisibleTurnSeq } from "./session-inspect.tsx";

describe("findVisibleTurnSeq", () => {
    const turns = Array.from({ length: 128 }, (_, i) => ({ seq: i + 1 }));
    const rectFor = (seq: number) => ({
        top: (seq - 1) * 100,
        bottom: seq * 100,
    });

    test("returns the turn crossing the scroll anchor", () => {
        expect(findVisibleTurnSeq(turns, 324, rectFor, null)).toBe(4);
    });

    test("returns the nearest previous turn when the anchor is between turns", () => {
        const sparseRectFor = (seq: number) => ({
            top: (seq - 1) * 120,
            bottom: (seq - 1) * 120 + 80,
        });

        expect(findVisibleTurnSeq(turns, 100, sparseRectFor, null)).toBe(1);
    });

    test("uses logarithmic DOM reads for large loaded windows", () => {
        let reads = 0;
        const found = findVisibleTurnSeq(turns, 12_424, (seq) => {
            reads += 1;
            return rectFor(seq);
        }, null);

        expect(found).toBe(125);
        expect(reads).toBeLessThanOrEqual(12);
    });

    test("falls back when no loaded turn has a DOM rect yet", () => {
        expect(findVisibleTurnSeq(turns, 100, () => null, 7)).toBe(7);
    });
});
