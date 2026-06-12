import { describe, expect, test } from "bun:test";
import {
    booleanField,
    boundExcerpt,
    boundedExcerpt,
    coercedNumberField,
    intField,
    isRecord,
    jsonText,
    nestedStringField,
    numberField,
    parseJsonRecord,
    parseJsonl,
    parseMaybeJson,
    stringArray,
    stringField,
} from "./toolkit.ts";

describe("parser toolkit JSON access", () => {
    test("isRecord narrows to plain object records only", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord([])).toBe(false);
        expect(isRecord(null)).toBe(false);
        expect(isRecord("x")).toBe(false);
        expect(isRecord(42)).toBe(false);
    });

    test("stringField returns strings and null otherwise", () => {
        expect(stringField({ a: "x" }, "a")).toBe("x");
        expect(stringField({ a: 1 }, "a")).toBeNull();
        expect(stringField({}, "a")).toBeNull();
    });

    test("numberField is strict: finite numbers only, no coercion, no truncation", () => {
        expect(numberField({ a: 1.5 }, "a")).toBe(1.5);
        expect(numberField({ a: "2" }, "a")).toBeNull();
        expect(numberField({ a: Number.NaN }, "a")).toBeNull();
        expect(numberField({ a: Infinity }, "a")).toBeNull();
        expect(numberField({}, "a")).toBeNull();
    });

    test("intField coerces numeric strings and truncates (codex variant)", () => {
        expect(intField({ a: 1.9 }, "a")).toBe(1);
        expect(intField({ a: "42" }, "a")).toBe(42);
        expect(intField({ a: "4.7" }, "a")).toBe(4);
        expect(intField({ a: "nope" }, "a")).toBeNull();
        expect(intField({ a: true }, "a")).toBeNull();
    });

    test("coercedNumberField accepts number|bigint|string without truncating (opencode variant)", () => {
        expect(coercedNumberField({ a: 1.5 }, "a")).toBe(1.5);
        expect(coercedNumberField({ a: 10n }, "a")).toBe(10);
        expect(coercedNumberField({ a: "2.5" }, "a")).toBe(2.5);
        expect(coercedNumberField({ a: " " }, "a")).toBeNull();
        expect(coercedNumberField({ a: "abc" }, "a")).toBeNull();
    });

    test("booleanField returns booleans and null otherwise", () => {
        expect(booleanField({ a: true }, "a")).toBe(true);
        expect(booleanField({ a: false }, "a")).toBe(false);
        expect(booleanField({ a: "true" }, "a")).toBeNull();
    });

    test("nestedStringField reads one record deep", () => {
        expect(nestedStringField({ m: { id: "x" } }, "m", "id")).toBe("x");
        expect(nestedStringField({ m: "flat" }, "m", "id")).toBeNull();
        expect(nestedStringField({}, "m", "id")).toBeNull();
    });

    test("parseJsonl decodes record lines and rejects non-records", () => {
        expect(parseJsonl('{"type":"message"}')).toEqual({ type: "message" });
        expect(parseJsonl("[1,2]")).toBeNull();
        expect(parseJsonl("not json")).toBeNull();
        expect(parseJsonl('"str"')).toBeNull();
    });

    test("parseJsonRecord pushes labelled warnings for missing/invalid/non-object data", () => {
        const warnings: string[] = [];
        expect(parseJsonRecord('{"a":1}', "row r1", warnings)).toEqual({ a: 1 });
        expect(warnings).toEqual([]);

        expect(parseJsonRecord(null, "row r2", warnings)).toBeNull();
        expect(warnings[0]).toBe("row r2: missing JSON data");

        expect(parseJsonRecord("  ", "row r3", warnings)).toBeNull();
        expect(warnings[1]).toBe("row r3: missing JSON data");

        expect(parseJsonRecord("{bad", "row r4", warnings)).toBeNull();
        expect(warnings[2]).toStartWith("row r4: invalid JSON data (");

        expect(parseJsonRecord("[1]", "row r5", warnings)).toBeNull();
        expect(warnings[3]).toBe("row r5: JSON data is not an object");
    });

    test("parseMaybeJson decodes strings, passes values through, nullish to null", () => {
        expect(parseMaybeJson('{"a":1}')).toEqual({ a: 1 });
        expect(parseMaybeJson("not json")).toBe("not json");
        expect(parseMaybeJson({ a: 1 })).toEqual({ a: 1 });
        expect(parseMaybeJson(undefined)).toBeNull();
        expect(parseMaybeJson(null)).toBeNull();
    });

    test("jsonText stringifies, collapsing undefined and circular input to null", () => {
        expect(jsonText({ a: 1 })).toBe('{"a":1}');
        expect(jsonText(undefined)).toBeNull();
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(jsonText(circular)).toBeNull();
    });

    test("boundedExcerpt slices without ellipsis", () => {
        expect(boundedExcerpt("short")).toBe("short");
        expect(boundedExcerpt("abcdef", 3)).toBe("abc");
        expect(boundedExcerpt("a".repeat(1300)).length).toBe(1200);
    });

    test("boundExcerpt normalizes, trims, and ellipsis-terminates when clipped (cursor variant)", () => {
        expect(boundExcerpt("  hi\r\nthere  ")).toBe("hi\nthere");
        expect(boundExcerpt({ a: 1 })).toBe('{"a":1}');
        expect(boundExcerpt(null)).toBeNull();
        expect(boundExcerpt("   ")).toBeNull();
        const clipped = boundExcerpt("x".repeat(20), 10)!;
        expect(clipped.length).toBe(10);
        expect(clipped.endsWith("…")).toBe(true);
    });

    test("stringArray keeps only string members and rejects non-arrays", () => {
        expect(stringArray(["a", 1, "b", null])).toEqual(["a", "b"]);
        expect(stringArray("a")).toBeNull();
        expect(stringArray(undefined)).toBeNull();
    });
});
