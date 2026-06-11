import { describe, expect, test } from "bun:test";
import { recordListSource, refListSource, selectByIds } from "./record-select.ts";

// The `.map(|$r| $r.*).filter(|$o| $o != NONE)` suffix materializes the
// records before SELECT iterates them - bare `FROM [refs]` throws "Specify a
// database to use" on SurrealDB 3.0.x (issue #251). See record-select.ts.
const MATERIALIZE = ".map(|$r| $r.*).filter(|$o| $o != NONE)";

describe("recordListSource", () => {
    test("backtick-quotes bare keys into a materialized record-list source", () => {
        expect(recordListSource("file", ["a", "b_c"])).toBe(`[file:\`a\`, file:\`b_c\`]${MATERIALIZE}`);
    });
    test("single key", () => {
        expect(recordListSource("skill", ["v2__x"])).toBe(`[skill:\`v2__x\`]${MATERIALIZE}`);
    });
    test("throws on an empty key (recordLiteral contract)", () => {
        expect(() => recordListSource("session", [""])).toThrow(/invalid record key/);
    });
});

describe("refListSource", () => {
    test("joins pre-formatted record literals verbatim", () => {
        expect(refListSource(["session:⟨u-1⟩", "session:`u-2`"])).toBe(`[session:⟨u-1⟩, session:\`u-2\`]${MATERIALIZE}`);
    });
});

describe("selectByIds", () => {
    test("emits the materialized record-list statement (NEVER `WHERE id IN`)", () => {
        const sql = selectByIds("name", "skill", ["a", "b"]);
        expect(sql).toBe(`SELECT name FROM [skill:\`a\`, skill:\`b\`]${MATERIALIZE};`);
        expect(sql).not.toContain("WHERE id IN");
    });
});
