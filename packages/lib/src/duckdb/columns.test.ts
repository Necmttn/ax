import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { JsonArrayColumn, JsonObjectColumn, TimestampColumn } from "./columns.ts";
import { UTC_CLOCK_TOLERANCE_MS, utcClockOk } from "./seam.ts";

const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
    Effect.runPromiseExit(
        Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<S["Type"], unknown>,
    );

/**
 * The RENDERED failure message - what a user or a log actually sees.
 *
 * Deliberately not `JSON.stringify(exit)`: Effect's issue tree carries the
 * ORIGINAL input value at the outer `Encoding` issue, so serializing the whole
 * exit always contains the full column value however this module formats its
 * own message. The message is the part this module controls and the part that
 * gets read.
 */
const failureMessage = async <S extends Schema.Top>(schema: S, value: unknown): Promise<string> => {
    // `Effect.flip` turns the SchemaError into the success channel so it can be
    // read directly. The double cast is the price of a fully-generic `S` here -
    // the concrete error type depends on the schema - and it is checked at
    // runtime immediately below, so a shape change fails loudly rather than
    // silently returning "undefined".
    const error: unknown = await Effect.runPromise(
        Effect.flip(Schema.decodeUnknownEffect(schema)(value)) as unknown as Effect.Effect<unknown>,
    );
    if (typeof error !== "object" || error === null || !("message" in error)) {
        throw new Error(`expected a SchemaError carrying a message, got ${JSON.stringify(error)}`);
    }
    return String(error.message);
};

const decoded = async <S extends Schema.Top>(schema: S, value: unknown) => {
    const exit = await decode(schema, value);
    if (exit._tag !== "Success") throw new Error(`expected a successful decode, got ${JSON.stringify(exit)}`);
    return exit.value;
};

describe("TimestampColumn", () => {
    test("accepts the Date the client decodes a TIMESTAMP cell into", async () => {
        const when = new Date("2026-08-15T10:11:12.345Z");
        expect(await decoded(TimestampColumn, when)).toEqual(when);
    });

    test("REJECTS the raw text the client falls back to for an unparseable timestamp", async () => {
        // `coerceValue` (row-decode.ts) returns the original TEXT rather than an
        // Invalid Date when a timestamp will not parse. Without this column
        // contract that string would flow on as a `Date`-shaped value and break
        // at the first `.getTime()`, far from the cause.
        const exit = await decode(TimestampColumn, "2026-13-45 99:99:99");
        expect(exit._tag).toBe("Failure");
    });

    test("rejects an Invalid Date", async () => {
        const exit = await decode(TimestampColumn, new Date("nonsense"));
        expect(exit._tag).toBe("Failure");
    });
});

describe("JsonArrayColumn", () => {
    const Labels = JsonArrayColumn(Schema.String);

    test("parses a JSON array of the declared element type", async () => {
        expect(await decoded(Labels, '["spar","dojo"]')).toEqual(["spar", "dojo"]);
    });

    test("parses an empty array", async () => {
        expect(await decoded(Labels, "[]")).toEqual([]);
    });

    test("rejects a JSON object with a message naming what it found", async () => {
        expect(await failureMessage(Labels, '{"a":1}')).toContain("expected a JSON array");
    });

    test("rejects malformed JSON and quotes the offending value", async () => {
        expect(await failureMessage(Labels, "[not json")).toContain("not valid JSON");
    });

    test("rejects an array whose ELEMENTS are the wrong type", async () => {
        // The parse boundary hands the target schema an unknown[]; the target is
        // what proves the element type, so this must not slip through.
        const exit = await decode(Labels, "[1,2,3]");
        expect(exit._tag).toBe("Failure");
    });

    test("excerpts a huge value in the failure message instead of echoing it whole", async () => {
        // A JSON column can hold a megabyte of transcript text; the message a
        // user or a log line renders must not become that megabyte.
        const message = await failureMessage(Labels, `{"a":"${"x".repeat(5000)}"}`);
        expect(message.length).toBeLessThan(400);
        expect(message).toContain("began");
        expect(message).toContain("…");
    });
});

describe("JsonObjectColumn", () => {
    const Meta = JsonObjectColumn(Schema.Struct({ kind: Schema.String, n: Schema.Number }));

    test("parses a JSON object through the declared shape", async () => {
        expect(await decoded(Meta, '{"kind":"tool","n":3}')).toEqual({ kind: "tool", n: 3 });
    });

    test("rejects a JSON array, saying so", async () => {
        expect(await failureMessage(Meta, "[1,2]")).toContain("expected a JSON object");
    });

    test("rejects a JSON null", async () => {
        const exit = await decode(Meta, "null");
        expect(exit._tag).toBe("Failure");
    });

    test("rejects an object that does not match the shape", async () => {
        const exit = await decode(Meta, '{"kind":"tool"}');
        expect(exit._tag).toBe("Failure");
    });
});

describe("utcClockOk", () => {
    const base = new Date("2026-08-15T10:00:00.000Z");
    const offset = (ms: number) => new Date(base.getTime() + ms);

    test("accepts an exact match and ordinary skew", () => {
        expect(utcClockOk(base, base)).toBe(true);
        expect(utcClockOk(offset(1_500), base)).toBe(true);
        expect(utcClockOk(offset(-1_500), base)).toBe(true);
    });

    test("accepts right up to the tolerance, in both directions", () => {
        expect(utcClockOk(offset(UTC_CLOCK_TOLERANCE_MS), base)).toBe(true);
        expect(utcClockOk(offset(-UTC_CLOCK_TOLERANCE_MS), base)).toBe(true);
    });

    test("rejects just past the tolerance", () => {
        expect(utcClockOk(offset(UTC_CLOCK_TOLERANCE_MS + 1), base)).toBe(false);
        expect(utcClockOk(offset(-UTC_CLOCK_TOLERANCE_MS - 1), base)).toBe(false);
    });

    test("rejects every real time-zone offset, including the smallest ones", () => {
        // The narrowest offsets in use are 15 and 30 minutes; the widest is +14h.
        for (const minutes of [15, -15, 30, -30, 45, 60, -60, 330, 840, -720]) {
            expect(utcClockOk(offset(minutes * 60_000), base)).toBe(false);
        }
    });
});
