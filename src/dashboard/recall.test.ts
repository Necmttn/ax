import { describe, expect, test } from "bun:test";
import { clampRecallLimit, clampRecallOffset } from "./recall.ts";
import { RECALL_COUNT_SQL, RECALL_TURNS_SQL } from "../queries/recall.ts";

describe("recall pagination", () => {
    test("clampRecallLimit defaults + bounds", () => {
        expect(clampRecallLimit(undefined)).toBe(50);
        expect(clampRecallLimit(0)).toBe(50);
        expect(clampRecallLimit(-5)).toBe(50);
        expect(clampRecallLimit(NaN)).toBe(50);
        expect(clampRecallLimit(20)).toBe(20);
        expect(clampRecallLimit(200)).toBe(200); // exact max
        expect(clampRecallLimit(201)).toBe(200); // max+1 still clamps
        expect(clampRecallLimit(9999)).toBe(200);
    });

    test("clampRecallOffset defaults + bounds", () => {
        expect(clampRecallOffset(undefined)).toBe(0);
        expect(clampRecallOffset(0)).toBe(0);
        expect(clampRecallOffset(-7)).toBe(0);
        expect(clampRecallOffset(NaN)).toBe(0);
        expect(clampRecallOffset(120)).toBe(120);
        expect(clampRecallOffset(50.9)).toBe(50);
    });

    test("RECALL_TURNS_SQL uses parameterised offset/limit", () => {
        const sql = RECALL_TURNS_SQL("");
        expect(sql).toMatch(/START \$offset/);
        expect(sql).toMatch(/LIMIT \$limit/);
        // sanity-check the WHERE filters still parameterise q/project/since.
        expect(sql).toMatch(/text_excerpt @@ \$q/);
    });

    test("RECALL_COUNT_SQL shares the same WHERE filter set", () => {
        const sql = RECALL_COUNT_SQL("AND session IN [session:a]");
        expect(sql).toMatch(/count\(\) AS total/);
        expect(sql).toMatch(/text_excerpt @@ \$q/);
        expect(sql).toMatch(/AND session IN \[session:a\]/);
        // Counts must not constrain by the window itself.
        expect(sql).not.toMatch(/\$offset/);
        expect(sql).not.toMatch(/\$limit/);
    });
});
