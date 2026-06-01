import { describe, expect, test } from "bun:test";

import { RecordId } from "surrealdb";
import {
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
} from "./surql.ts";

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
