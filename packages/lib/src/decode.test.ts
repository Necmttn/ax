import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
    decodeJsonOrNull,
    decodeJsonOrNullAs,
    decodeJsonRecordOrNull,
    encodeJsonOrNull,
    jsonArrayField,
    jsonField,
    jsonRecordField,
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

describe("jsonField", () => {
    const Metrics = Schema.Struct({
        fix_chain_count: Schema.optional(Schema.Number),
        label: Schema.optional(Schema.String),
    });
    const metricsField = jsonField(Metrics);

    test("decodes a valid JSON-encoded nested field to its typed shape", () => {
        expect(metricsField.decode('{"fix_chain_count":4}')).toEqual({ fix_chain_count: 4 });
        expect(metricsField.decode('{"fix_chain_count":4,"extra":true}')).toEqual({
            fix_chain_count: 4,
        });
    });

    test("returns null for null/undefined input", () => {
        expect(metricsField.decode(null)).toBeNull();
        expect(metricsField.decode(undefined)).toBeNull();
    });

    test("returns null for corrupt JSON or schema mismatches", () => {
        expect(metricsField.decode("")).toBeNull();
        expect(metricsField.decode("{")).toBeNull();
        expect(metricsField.decode("not json")).toBeNull();
        expect(metricsField.decode('{"fix_chain_count":"four"}')).toBeNull();
        expect(metricsField.decode("[1,2]")).toBeNull();
    });

    test("counts decode failures via onDecodeFailure without changing the result", () => {
        const failures: string[] = [];
        const counted = jsonField(Metrics, { onDecodeFailure: (input) => failures.push(input) });
        expect(counted.decode('{"fix_chain_count":1}')).toEqual({ fix_chain_count: 1 });
        expect(counted.decode("{corrupt")).toBeNull();
        expect(counted.decode(null)).toBeNull(); // null input is absent, not corrupt
        expect(failures).toEqual(["{corrupt"]);
    });

    test("round-trips encode -> decode", () => {
        const value = { fix_chain_count: 2, label: "x" };
        const encoded = metricsField.encode(value);
        expect(typeof encoded).toBe("string");
        expect(metricsField.decode(encoded)).toEqual(value);
    });

    test("jsonRecordField accepts only JSON object records", () => {
        expect(jsonRecordField.decode('{"a":1}')).toEqual({ a: 1 });
        expect(jsonRecordField.decode("[1,2]")).toBeNull();
        expect(jsonRecordField.decode("null")).toBeNull();
        expect(jsonRecordField.decode("5")).toBeNull();
        expect(jsonRecordField.encode({ a: 1 })).toBe('{"a":1}');
    });

    test("jsonArrayField accepts only JSON arrays", () => {
        expect(jsonArrayField.decode('[1,"a"]')).toEqual([1, "a"]);
        expect(jsonArrayField.decode("[]")).toEqual([]);
        expect(jsonArrayField.decode('{"a":1}')).toBeNull();
        expect(jsonArrayField.decode("not json")).toBeNull();
    });
});
