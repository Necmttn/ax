import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
    decodeJsonOrNull,
    decodeJsonOrNullAs,
    decodeJsonRecordOrNull,
    encodeJsonOrNull,
} from "./decode.ts";

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

    test("validates decoded JSON against a typed Schema", () => {
        const HookPayload = Schema.Struct({
            event: Schema.String,
            files: Schema.Array(Schema.String),
        });

        expect(decodeJsonOrNullAs(HookPayload, '{"event":"read","files":["src/a.ts"]}')).toEqual({
            event: "read",
            files: ["src/a.ts"],
        });
        expect(decodeJsonOrNullAs(HookPayload, '{"event":"read","files":[1]}')).toBeNull();
    });

    test("decodes only JSON object records for record boundaries", () => {
        expect(decodeJsonRecordOrNull('{"a":1}')).toEqual({ a: 1 });
        expect(decodeJsonRecordOrNull("[1,2,3]")).toBeNull();
        expect(decodeJsonRecordOrNull("null")).toBeNull();
    });

    test("encodes machine-boundary JSON through Schema", () => {
        expect(encodeJsonOrNull({ a: 1 })).toBe('{"a":1}');
        expect(encodeJsonOrNull(["x", true])).toBe('["x",true]');
    });
});
