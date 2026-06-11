import { describe, expect, test } from "bun:test";
import { computeBurnBuckets } from "./burn-buckets.ts";

describe("computeBurnBuckets", () => {
    test("empty input -> empty array", () => {
        expect(computeBurnBuckets([])).toEqual([]);
    });

    test("fewer turns than buckets -> one bucket per turn, order preserved", () => {
        expect(computeBurnBuckets([10, 20, 30])).toEqual([10, 20, 30]);
    });

    test("exactly 20 turns -> identity", () => {
        const turns = Array.from({ length: 20 }, (_, i) => i + 1);
        expect(computeBurnBuckets(turns)).toEqual(turns);
    });

    test("more turns than buckets -> sums per bucket, total preserved", () => {
        // 40 turns of 1 token -> 20 buckets of 2
        const turns = Array.from({ length: 40 }, () => 1);
        const buckets = computeBurnBuckets(turns);
        expect(buckets).toHaveLength(20);
        expect(buckets.every((b) => b === 2)).toBe(true);
    });

    test("uneven split keeps total", () => {
        const turns = Array.from({ length: 33 }, (_, i) => i);
        const buckets = computeBurnBuckets(turns);
        expect(buckets).toHaveLength(20);
        expect(buckets.reduce((a, b) => a + b, 0)).toBe(turns.reduce((a, b) => a + b, 0));
    });

    test("non-finite and negative inputs clamp to 0", () => {
        expect(computeBurnBuckets([Number.NaN, -5, 7])).toEqual([0, 0, 7]);
    });

    test("bucketCount <= 0 -> empty array", () => {
        expect(computeBurnBuckets([1, 2, 3], 0)).toEqual([]);
    });
});
