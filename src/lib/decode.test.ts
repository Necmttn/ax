import { describe, expect, test } from "bun:test";
import { decodeJsonOrNull } from "./decode.ts";

describe("decodeJsonOrNull", () => {
    test("decodes valid JSON to its parsed value", () => {
        expect(decodeJsonOrNull('{"a":1}')).toEqual({ a: 1 });
        expect(decodeJsonOrNull("[1,2,3]")).toEqual([1, 2, 3]);
        expect(decodeJsonOrNull('"hello"')).toBe("hello");
        expect(decodeJsonOrNull("42")).toBe(42);
        expect(decodeJsonOrNull("true")).toBe(true);
        expect(decodeJsonOrNull("null")).toBeNull();
    });

    test("returns null for malformed JSON instead of throwing", () => {
        expect(decodeJsonOrNull("")).toBeNull();
        expect(decodeJsonOrNull("not json")).toBeNull();
        expect(decodeJsonOrNull("{a:1}")).toBeNull();
        expect(decodeJsonOrNull("{")).toBeNull();
    });
});
