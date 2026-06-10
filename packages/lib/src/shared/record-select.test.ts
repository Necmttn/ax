import { describe, expect, test } from "bun:test";
import { recordListSource, refListSource, selectByIds } from "./record-select.ts";

describe("recordListSource", () => {
    test("backtick-quotes bare keys into a record-list source", () => {
        expect(recordListSource("file", ["a", "b_c"])).toBe("[file:`a`, file:`b_c`]");
    });
    test("single key", () => {
        expect(recordListSource("skill", ["v2__x"])).toBe("[skill:`v2__x`]");
    });
    test("throws on an empty key (recordLiteral contract)", () => {
        expect(() => recordListSource("session", [""])).toThrow(/invalid record key/);
    });
});

describe("refListSource", () => {
    test("joins pre-formatted record literals verbatim", () => {
        expect(refListSource(["session:⟨u-1⟩", "session:`u-2`"])).toBe("[session:⟨u-1⟩, session:`u-2`]");
    });
});

describe("selectByIds", () => {
    test("emits the record-list selection statement (NEVER `WHERE id IN`)", () => {
        const sql = selectByIds("name", "skill", ["a", "b"]);
        expect(sql).toBe("SELECT name FROM [skill:`a`, skill:`b`];");
        expect(sql).not.toContain("WHERE id IN");
    });
});
