import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "./bigint-column.ts";

// Pure coverage of the BIGINT-column coercion (no dylib needed): the DB-backed
// round-trip lives in client.test.ts (a real BIGINT column), this pins the
// Schema behavior itself.
describe("NumberFromBigIntColumn", () => {
    const decode = (v: unknown) =>
        Effect.runSync(Effect.result(Schema.decodeUnknownEffect(NumberFromBigIntColumn)(v)));

    test("coerces a bigint to a number", () => {
        const r = decode(42n);
        expect(r._tag).toBe("Success");
        if (r._tag === "Success") expect(r.success).toBe(42);
    });

    test("passes a plain number through", () => {
        const r = decode(7);
        expect(r._tag).toBe("Success");
        if (r._tag === "Success") expect(r.success).toBe(7);
    });

    test("FAILS (never truncates) when the bigint exceeds Number's safe range", () => {
        const over = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
        const r = decode(over);
        expect(r._tag).toBe("Failure");
    });

    test("FAILS below the safe range too", () => {
        const under = BigInt(Number.MIN_SAFE_INTEGER) - 2n;
        expect(decode(under)._tag).toBe("Failure");
    });

    test("boundary values are accepted exactly", () => {
        const max = decode(BigInt(Number.MAX_SAFE_INTEGER));
        expect(max._tag).toBe("Success");
        if (max._tag === "Success") expect(max.success).toBe(Number.MAX_SAFE_INTEGER);
    });
});
