import { describe, expect, test, it } from "bun:test";
import { Effect } from "effect";
import { RecordId } from "surrealdb";
import {
    // literals / escaping
    surrealJson,
    surrealJsonOption,
    surrealString,
    recordRef,
    surrealRecordKey,
    surrealDate,
    surrealObject,
    surrealSet,
    surrealOptionString,
    surrealOptionInt,
    surrealOptionDate,
    surrealOptionRecord,
    surrealJsonText,
    surrealJsonTextOption,
    surrealValue,
    // typed row field access
    isRecord,
    stringField,
    stringFieldOr,
    dateField,
    numberFieldOrNull,
    countField,
    numberOrNull,
    numberOrZero,
    stringOrNull,
    recordIdString,
    // record selection
    recordListSource,
    refListSource,
    selectByIds,
    // statement execution
    executeStatements,
    // record-id key derivation
    isoTimestamp,
    nonEmptyString,
    recordKeyPart,
    safeKeyPart,
} from "./surreal.ts";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import { makeTestSurrealClient } from "../testing/surreal.ts";

// ============================================================================
// 1. LITERALS / ESCAPING (was surql.test.ts)
// ============================================================================

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("surrealString", () => {
    test("quotes plain ASCII unchanged", () => {
        expect(surrealString("hello")).toBe('"hello"');
    });

    test("escapes embedded quotes, newlines, backslashes as JSON does", () => {
        const input = 'a"b\nc\\d';
        const out = surrealString(input);
        expect(out).toBe(JSON.stringify(input));
        expect(JSON.parse(out)).toBe(input);
    });

    test("removes a lone high surrogate", () => {
        const out = surrealString("emoji-half\uD83D");
        expect(LONE_SURROGATE.test(out)).toBe(false);
        expect(JSON.parse(out)).toBe("emoji-half");
    });

    test("removes a lone low surrogate", () => {
        const out = surrealString("\uDE00-tail");
        expect(LONE_SURROGATE.test(out)).toBe(false);
        expect(JSON.parse(out)).toBe("-tail");
    });

    test("preserves a valid surrogate pair (real emoji)", () => {
        const out = surrealString("idea 💡 done");
        expect(JSON.parse(out)).toBe("idea 💡 done");
    });

    test("nullish input coerces to an empty-string literal", () => {
        // DB-sourced rows hand back undefined/null where a string was
        // declared; surrealString must not throw on them.
        expect(surrealString(undefined as unknown as string)).toBe('""');
        expect(surrealString(null as unknown as string)).toBe('""');
    });

    test("crash-input shape produces parser-safe output", () => {
        // Reconstructs the shape from the SurrealDB parse error:
        // an excerpt ending in `## ` followed by a lone high surrogate.
        const crashInput = "...714\n\n## \uD83D";
        const out = surrealString(crashInput);
        expect(LONE_SURROGATE.test(out)).toBe(false);
        expect(out.includes("\\uD83D")).toBe(false);
        expect(out.includes("\\ud83d")).toBe(false);
        expect(JSON.parse(out)).toBe("...714\n\n## ");
    });
});

describe("surrealJson", () => {
    test("serialises an object to a quoted JSON string", () => {
        const out = surrealJson({ cmd: "pwd", n: 1 });
        expect(JSON.parse(out)).toBe('{"cmd":"pwd","n":1}');
    });

    test("undefined input becomes the literal \"null\"", () => {
        expect(surrealJson(undefined)).toBe('"null"');
    });

    test("output never carries a raw lone surrogate", () => {
        // The inner JSON.stringify already turns a lone surrogate into the
        // literal ASCII escape `\uD83D`, so the SurrealQL literal is parser-
        // safe; the outer surrealString also runs the strip pass as defence.
        const out = surrealJson({ excerpt: "split\uD83D" });
        expect(LONE_SURROGATE.test(out)).toBe(false);
        // The literal is a well-formed JSON string of a JSON string.
        expect(typeof JSON.parse(out)).toBe("string");
    });
});

describe("surrealJsonOption", () => {
    test("null produces unquoted NONE", () => {
        expect(surrealJsonOption(null)).toBe("NONE");
    });

    test("undefined produces unquoted NONE", () => {
        expect(surrealJsonOption(undefined)).toBe("NONE");
    });

    test("a value produces a quoted JSON string", () => {
        const out = surrealJsonOption({ a: 1 });
        expect(JSON.parse(out)).toBe('{"a":1}');
    });
});

describe("crash regression", () => {
    test("string ending in a lone high surrogate round-trips safely", () => {
        const input = "text\n\n## " + "\uD83D";
        const out = surrealString(input);
        expect(LONE_SURROGATE.test(out)).toBe(false);
        // JSON.parse must succeed and the decoded text must also be clean.
        const decoded = JSON.parse(out) as string;
        expect(LONE_SURROGATE.test(decoded)).toBe(false);
        expect(decoded).toBe("text\n\n## ");
    });
});

describe("recordRef", () => {
    test("wraps key in backticks", () => {
        expect(recordRef("session", "abc")).toBe("session:`abc`");
    });
    test("escapes backticks and control chars in the key", () => {
        expect(recordRef("t", "a`b\nc")).toBe("t:`a\\`b\\nc`");
    });
});

describe("surrealRecordKey", () => {
    test("escapes backslash, backtick, newline, return, tab", () => {
        expect(surrealRecordKey("a\\b`c\nd\re\tf")).toBe("a\\\\b\\`c\\nd\\re\\tf");
    });
});

describe("surrealDate", () => {
    test("emits a d-prefixed JSON ISO string", () => {
        expect(surrealDate(new Date("2026-01-02T03:04:05.000Z"))).toBe(
            'd"2026-01-02T03:04:05.000Z"',
        );
    });
    test("accepts a pre-formed ISO string", () => {
        expect(surrealDate("2026-01-02T03:04:05.000Z")).toBe(
            'd"2026-01-02T03:04:05.000Z"',
        );
    });
});

describe("surrealObject / surrealSet", () => {
    test("surrealObject joins name:value pairs in braces", () => {
        expect(surrealObject([["a", "1"], ["b", '"x"']])).toBe('{ a: 1, b: "x" }');
    });
    test("surrealSet joins name = value pairs", () => {
        expect(surrealSet([["a", "1"], ["b", '"x"']])).toBe('a = 1, b = "x"');
    });
});

describe("option helpers", () => {
    test("surrealOptionString → NONE for nullish", () => {
        expect(surrealOptionString(null)).toBe("NONE");
        expect(surrealOptionString(undefined)).toBe("NONE");
        expect(surrealOptionString("x")).toBe('"x"');
    });
    test("surrealOptionInt truncates and NONE for non-finite", () => {
        expect(surrealOptionInt(3.9)).toBe("3");
        expect(surrealOptionInt(null)).toBe("NONE");
        expect(surrealOptionInt(Number.NaN)).toBe("NONE");
    });
    test("surrealOptionDate → NONE for nullish", () => {
        expect(surrealOptionDate(null)).toBe("NONE");
    });
    test("surrealOptionRecord → NONE for nullish key", () => {
        expect(surrealOptionRecord("session", null)).toBe("NONE");
        expect(surrealOptionRecord("session", "k")).toBe("session:`k`");
    });
});

describe("surrealJsonText (pass-through semantics)", () => {
    test("a string value is NOT re-stringified", () => {
        expect(surrealJsonText('{"a":1}')).toBe('"{\\"a\\":1}"');
    });
    test("a non-string value is JSON-encoded once", () => {
        expect(surrealJsonText({ a: 1 })).toBe('"{\\"a\\":1}"');
    });
    test("surrealJsonTextOption → NONE for nullish", () => {
        expect(surrealJsonTextOption(null)).toBe("NONE");
        expect(surrealJsonTextOption(undefined)).toBe("NONE");
    });
});

describe("surrealValue (universal encoder)", () => {
    test("string → quoted literal", () => {
        expect(surrealValue("x")).toBe('"x"');
    });
    test("finite number → bare literal", () => {
        expect(surrealValue(3)).toBe("3");
    });
    test("boolean → true/false", () => {
        expect(surrealValue(true)).toBe("true");
    });
    test("null/undefined → NONE", () => {
        expect(surrealValue(null)).toBe("NONE");
        expect(surrealValue(undefined)).toBe("NONE");
    });
    test("Date → surrealDate literal", () => {
        expect(surrealValue(new Date("2026-01-02T03:04:05.000Z"))).toBe(
            'd"2026-01-02T03:04:05.000Z"',
        );
    });
    test("array → bracketed list of encoded values", () => {
        expect(surrealValue([1, "a"])).toBe('[1, "a"]');
    });
    test("plain object → surrealJson literal", () => {
        expect(surrealValue({ a: 1 })).toBe('"{\\"a\\":1}"');
    });
    test("RecordId → native record reference literal", () => {
        const rid = new RecordId("session", "s1");
        expect(surrealValue(rid)).toBe("session:`s1`");
    });
    test("array of RecordId → bracketed record refs", () => {
        const rids = [new RecordId("session", "s1"), new RecordId("session", "s2")];
        expect(surrealValue(rids)).toBe("[session:`s1`, session:`s2`]");
    });
    test("RecordId with a non-string id falls through to JSON, not a mangled ref", () => {
        const rid = { table: { name: "t" }, id: { x: 1 } };
        // not a native ref - must not produce t:`[object Object]`
        expect(surrealValue(rid)).not.toContain("[object Object]");
    });
});

// ============================================================================
// 2. TYPED ROW FIELD ACCESS (was row-fields.test.ts)
// ============================================================================

describe("isRecord", () => {
    test("true for plain object, false for array/null", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
    });
});

describe("stringField", () => {
    test("returns non-empty string, else null", () => {
        expect(stringField({ a: "x" }, "a")).toBe("x");
        expect(stringField({ a: "" }, "a")).toBe(null);
        expect(stringField({ a: 3 }, "a")).toBe(null);
    });
});

describe("dateField", () => {
    test("ISO string passthrough", () => {
        expect(dateField({ t: "2026-01-01T00:00:00.000Z" }, "t")).toBe(
            "2026-01-01T00:00:00.000Z",
        );
    });
    test("Date → ISO", () => {
        expect(dateField({ t: new Date("2026-01-01T00:00:00.000Z") }, "t")).toBe(
            "2026-01-01T00:00:00.000Z",
        );
    });
    test("missing → null", () => {
        expect(dateField({}, "t")).toBe(null);
    });
});

describe("numberFieldOrNull", () => {
    test("finite number passthrough, else null", () => {
        expect(numberFieldOrNull({ n: 3 }, "n")).toBe(3);
        expect(numberFieldOrNull({ n: "3" }, "n")).toBe(null);
    });
});

describe("countField", () => {
    test("coerces numeric-ish values, defaults to 0", () => {
        expect(countField({ n: 3 }, "n")).toBe(3);
        expect(countField({ n: "3" }, "n")).toBe(3);
        expect(countField({}, "n")).toBe(0);
        expect(countField({ n: Number.NEGATIVE_INFINITY }, "n")).toBe(0);
        expect(countField({ n: "junk" }, "n")).toBe(0);
    });
});

describe("recordIdString", () => {
    test("string passthrough", () => {
        expect(recordIdString("session:abc")).toBe("session:abc");
    });
    test("RecordId-like object → toString", () => {
        expect(recordIdString({ toString: () => "session:x" })).toBe("session:x");
    });
    test("null → null", () => {
        expect(recordIdString(null)).toBe(null);
    });
});

// New helpers: stringFieldOr, numberOrNull, numberOrZero, stringOrNull

describe("stringFieldOr", () => {
    test("returns string value unchanged", () => {
        expect(stringFieldOr({ model: "claude-opus" }, "model")).toBe("claude-opus");
    });
    test("coerces a number field to string (key distinguisher: stringField would return null)", () => {
        // String(3 ?? "") = "3" vs stringField = null
        expect(stringFieldOr({ n: 3 }, "n")).toBe("3");
        expect(stringField({ n: 3 }, "n")).toBe(null); // strict comparison
    });
    test("coerces a RecordId-like object via toString (no [object Object] regression)", () => {
        const rid = { toString: () => "session:abc" };
        expect(stringFieldOr({ id: rid }, "id")).toBe("session:abc");
        expect(stringFieldOr({ id: rid }, "id")).not.toContain("[object Object]");
    });
    test("null field → default empty string", () => {
        expect(stringFieldOr({ k: null }, "k")).toBe("");
    });
    test("undefined field (missing key) → default empty string", () => {
        expect(stringFieldOr({}, "k")).toBe("");
    });
    test("custom fallback is used for null/undefined", () => {
        expect(stringFieldOr({ k: null }, "k", "fallback")).toBe("fallback");
        expect(stringFieldOr({}, "k", "(missing)")).toBe("(missing)");
    });
    test("empty string is returned as-is (not null, not fallback)", () => {
        // String("" ?? "") stays "" - different from stringField which needs non-empty
        expect(stringFieldOr({ k: "" }, "k")).toBe("");
    });
    test("boolean field → string", () => {
        expect(stringFieldOr({ v: true }, "v")).toBe("true");
        expect(stringFieldOr({ v: false }, "v")).toBe("false");
    });
});

describe("numberOrNull", () => {
    test("finite number passthrough", () => {
        expect(numberOrNull(3)).toBe(3);
        expect(numberOrNull(0)).toBe(0);
        expect(numberOrNull(-1.5)).toBe(-1.5);
    });
    test("coerces a numeric string to number", () => {
        expect(numberOrNull("3")).toBe(3);
        expect(numberOrNull("0")).toBe(0);
    });
    test("null → null (not 0, unlike countField)", () => {
        expect(numberOrNull(null)).toBe(null);
    });
    test("undefined → null", () => {
        expect(numberOrNull(undefined)).toBe(null);
    });
    test("NaN → null (finite guard)", () => {
        expect(numberOrNull(Number.NaN)).toBe(null);
    });
    test("Infinity → null (finite guard)", () => {
        expect(numberOrNull(Number.POSITIVE_INFINITY)).toBe(null);
        expect(numberOrNull(Number.NEGATIVE_INFINITY)).toBe(null);
    });
    test("non-numeric string → null", () => {
        expect(numberOrNull("junk")).toBe(null);
    });
    test("empty string → 0 (Number('') = 0 is finite)", () => {
        // This is the documented coercing semantics: Number("") = 0
        expect(numberOrNull("")).toBe(0);
    });
});

describe("numberOrZero", () => {
    test("finite number passthrough", () => {
        expect(numberOrZero(5)).toBe(5);
    });
    test("null → 0", () => {
        expect(numberOrZero(null)).toBe(0);
    });
    test("undefined → 0", () => {
        expect(numberOrZero(undefined)).toBe(0);
    });
    test("NaN → 0 (finite guard - the NaN-leak fix)", () => {
        expect(numberOrZero(Number.NaN)).toBe(0);
    });
    test("non-numeric string → 0", () => {
        expect(numberOrZero("junk")).toBe(0);
    });
    test("numeric string → coerced number", () => {
        expect(numberOrZero("42")).toBe(42);
    });
});

describe("stringOrNull", () => {
    test("non-empty string passthrough", () => {
        expect(stringOrNull("x")).toBe("x");
    });
    test("empty string → null", () => {
        expect(stringOrNull("")).toBe(null);
    });
    test("number → null (strict, no coercion; use stringFieldOr for coercion)", () => {
        expect(stringOrNull(3)).toBe(null);
    });
    test("null → null", () => {
        expect(stringOrNull(null)).toBe(null);
    });
    test("undefined → null", () => {
        expect(stringOrNull(undefined)).toBe(null);
    });
    test("object → null", () => {
        expect(stringOrNull({})).toBe(null);
    });
});

// ============================================================================
// 3. RECORD SELECTION (was record-select.test.ts)
// ============================================================================

// The `.map(|$r| $r.*).filter(|$o| $o != NONE)` suffix materializes the
// records before SELECT iterates them - bare `FROM [refs]` throws "Specify a
// database to use" on SurrealDB 3.0.x (issue #251). See surreal.ts.
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

describe("pick projection", () => {
    test("narrows materialization to a destructured field subset", () => {
        expect(recordListSource("turn", ["t1"], ["id", "session"]))
            .toBe("[turn:`t1`].map(|$r| $r.{id, session}).filter(|$o| $o != NONE)");
        expect(refListSource(["turn:`t1`"], ["seq", "text"]))
            .toBe("[turn:`t1`].map(|$r| $r.{seq, text}).filter(|$o| $o != NONE)");
        expect(selectByIds("session", "turn", ["t1"], ["id", "session"]))
            .toBe("SELECT session FROM [turn:`t1`].map(|$r| $r.{id, session}).filter(|$o| $o != NONE);");
    });
    test("rejects empty and non-identifier pick fields", () => {
        expect(() => recordListSource("turn", ["t1"], [])).toThrow(/empty pick/);
        expect(() => recordListSource("turn", ["t1"], ["a b"])).toThrow(/invalid pick field/);
        expect(() => refListSource(["turn:`t1`"], ["x;DROP"])).toThrow(/invalid pick field/);
    });
});

// ============================================================================
// 4. STATEMENT EXECUTION (was statement-exec.test.ts)
// ============================================================================

/** In-memory recorder adapter - the second adapter that makes this a real seam. */
const recordingClient = (): { calls: string[]; layer: SurrealClientShape } => {
    const tc = makeTestSurrealClient({ fallback: [] });
    return { calls: tc.captured, layer: tc.client };
};

const run = (eff: Effect.Effect<unknown, unknown, SurrealClient>, layer: SurrealClientShape) =>
    Effect.runPromise(eff.pipe(Effect.provideService(SurrealClient, layer)));

describe("executeStatements", () => {
    test("no statements → no query call", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements([]), layer);
        expect(calls).toEqual([]);
    });

    test("statements within one chunk → a single joined query", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements(["A;", "B;"]), layer);
        expect(calls).toEqual(["A;B;"]);
    });

    test("chunkSize splits into multiple queries", async () => {
        const { calls, layer } = recordingClient();
        await run(executeStatements(["A;", "B;", "C;"], { chunkSize: 2 }), layer);
        expect(calls).toEqual(["A;B;", "C;"]);
    });

    test("default chunk size is 250", async () => {
        const { calls, layer } = recordingClient();
        const stmts = Array.from({ length: 251 }, (_, i) => `S${i};`);
        await run(executeStatements(stmts), layer);
        expect(calls.length).toBe(2);
    });
});

// ============================================================================
// 5. RECORD-ID KEY DERIVATION (was derive-keys.test.ts)
// ============================================================================

describe("safeKeyPart", () => {
    it("replaces colons with double underscores", () => {
        expect(safeKeyPart("foo:bar")).toBe("foo__bar");
    });

    it("replaces non-alphanumeric characters with underscores", () => {
        expect(safeKeyPart("hello world")).toBe("hello_world");
    });

    it("collapses runs of 3+ underscores to double underscore", () => {
        // colon becomes __ then _ from non-alnum, giving ___ → __
        expect(safeKeyPart("a: b")).toBe("a__b");
    });

    it("trims leading and trailing underscores", () => {
        expect(safeKeyPart("_foo_bar_")).toBe("foo_bar");
    });

    it("slices output at 96 chars", () => {
        const long = "a".repeat(200);
        const result = safeKeyPart(long);
        expect(result.length).toBe(96);
    });

    it("returns exactly 96 chars when sanitized result is longer than 96", () => {
        const long = "x".repeat(100);
        expect(safeKeyPart(long).length).toBe(96);
    });

    it("returns a hash when sanitized result is empty", () => {
        // Only special chars → sanitized = "" → hash
        const result = safeKeyPart("---");
        expect(result).toBe(Bun.hash("---").toString(16));
    });

    it("handles plugin-namespaced names (colon)", () => {
        expect(safeKeyPart("plugin:skill-name")).toBe("plugin__skill_name");
    });
});

describe("recordKeyPart", () => {
    it("strips expected table prefix", () => {
        expect(recordKeyPart("session:abc123", "session")).toBe("abc123");
    });

    it("strips any table prefix when expectedTable not given", () => {
        expect(recordKeyPart("turn:xyz", undefined)).toBe("xyz");
    });

    it("strips backtick quoting from key part", () => {
        expect(recordKeyPart("session:`my-key`", "session")).toBe("my-key");
    });

    it("strips angle-bracket quoting from key part", () => {
        expect(recordKeyPart("session:⟨my-key⟩", "session")).toBe("my-key");
    });

    it("handles .id objects", () => {
        expect(recordKeyPart({ id: "abc" })).toBe("abc");
    });

    it("returns null for .id objects with null id", () => {
        expect(recordKeyPart({ id: null })).toBeNull();
    });

    it("returns null for null input", () => {
        expect(recordKeyPart(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
        expect(recordKeyPart(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
        expect(recordKeyPart("   ")).toBeNull();
    });

    it("returns null when key part after stripping is empty", () => {
        expect(recordKeyPart("session:", "session")).toBeNull();
    });

    it("strips unexpected table prefix generically", () => {
        expect(recordKeyPart("tool:abc", "session")).toBe("abc");
    });
});

describe("isoTimestamp", () => {
    it("returns ISO string for a Date object", () => {
        const d = new Date("2024-01-15T10:30:00.000Z");
        expect(isoTimestamp(d)).toBe("2024-01-15T10:30:00.000Z");
    });

    it("passes through a non-empty string unchanged", () => {
        expect(isoTimestamp("2024-03-01T00:00:00.000Z")).toBe("2024-03-01T00:00:00.000Z");
    });

    it("handles SurrealDB DateTime objects via constructor name check", () => {
        const fakeDateTime = {
            constructor: { name: "DateTime" },
            toString() { return "2024-06-01T12:00:00.000Z"; },
        };
        // Cast to satisfy TS - at runtime this is an object with the right constructor name
        expect(isoTimestamp(fakeDateTime as unknown as Date)).toBe("2024-06-01T12:00:00.000Z");
    });

    it("returns epoch ISO for null", () => {
        expect(isoTimestamp(null)).toBe(new Date(0).toISOString());
    });

    it("returns epoch ISO for undefined", () => {
        expect(isoTimestamp(undefined)).toBe(new Date(0).toISOString());
    });

    it("returns epoch ISO for empty string", () => {
        // empty string → not a non-empty string → falls through to epoch
        expect(isoTimestamp("" as unknown as Date)).toBe(new Date(0).toISOString());
    });
});

describe("isoTimestamp - warn on epoch fallback", () => {
    // Helper: capture and restore console.warn around a callback.
    const withWarnSpy = (fn: (calls: unknown[][]) => void): void => {
        const original = console.warn;
        const calls: unknown[][] = [];
        console.warn = (...args: unknown[]) => { calls.push(args); };
        try {
            fn(calls);
        } finally {
            console.warn = original;
        }
    };

    it("does NOT warn for a valid Date", () => {
        withWarnSpy((calls) => {
            isoTimestamp(new Date("2024-01-15T10:30:00.000Z"));
            expect(calls.length).toBe(0);
        });
    });

    it("does NOT warn for a non-empty string", () => {
        withWarnSpy((calls) => {
            isoTimestamp("2024-03-01T00:00:00.000Z");
            expect(calls.length).toBe(0);
        });
    });

    it("does NOT warn for a SurrealDB DateTime-like object", () => {
        withWarnSpy((calls) => {
            const fakeDateTime = {
                constructor: { name: "DateTime" },
                toString() { return "2024-06-01T12:00:00.000Z"; },
            };
            isoTimestamp(fakeDateTime as unknown as Date);
            expect(calls.length).toBe(0);
        });
    });

    it("warns exactly once and returns epoch for null", () => {
        withWarnSpy((calls) => {
            const result = isoTimestamp(null);
            expect(result).toBe(new Date(0).toISOString());
            expect(calls.length).toBe(1);
            expect(String(calls[0]![0])).toContain("[ax] isoTimestamp");
        });
    });

    it("warns exactly once and returns epoch for undefined", () => {
        withWarnSpy((calls) => {
            const result = isoTimestamp(undefined);
            expect(result).toBe(new Date(0).toISOString());
            expect(calls.length).toBe(1);
            expect(String(calls[0]![0])).toContain("[ax] isoTimestamp");
        });
    });

    it("warns exactly once and returns epoch for empty string", () => {
        withWarnSpy((calls) => {
            const result = isoTimestamp("" as unknown as Date);
            expect(result).toBe(new Date(0).toISOString());
            expect(calls.length).toBe(1);
            expect(String(calls[0]![0])).toContain("[ax] isoTimestamp");
        });
    });
});

describe("nonEmptyString", () => {
    it("returns the trimmed string when non-empty", () => {
        expect(nonEmptyString("  hello  ")).toBe("hello");
    });

    it("returns null for a blank string", () => {
        expect(nonEmptyString("   ")).toBeNull();
    });

    it("returns null for an empty string", () => {
        expect(nonEmptyString("")).toBeNull();
    });

    it("returns null for null", () => {
        expect(nonEmptyString(null)).toBeNull();
    });

    it("returns null for undefined", () => {
        expect(nonEmptyString(undefined)).toBeNull();
    });

    it("returns null for a number", () => {
        expect(nonEmptyString(42)).toBeNull();
    });

    it("returns null for an object", () => {
        expect(nonEmptyString({ x: 1 })).toBeNull();
    });
});
