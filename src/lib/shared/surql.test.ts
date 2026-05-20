import { describe, expect, test } from "bun:test";

import { surrealJson, surrealJsonOption, surrealString } from "./surql.ts";

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
