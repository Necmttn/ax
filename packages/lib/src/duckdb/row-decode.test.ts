import { describe, expect, test } from "bun:test";
import { accessorFor, coerceValue, unsupportedColumns } from "./row-decode.ts";
import { DuckDbTypeId } from "./types.ts";

describe("accessorFor", () => {
    test("maps each integer width to the widest safe decoder family", () => {
        for (const id of [
            DuckDbTypeId.TINYINT,
            DuckDbTypeId.SMALLINT,
            DuckDbTypeId.INTEGER,
            DuckDbTypeId.BIGINT,
        ]) {
            expect(accessorFor(id)).toBe("int64");
        }
        for (const id of [
            DuckDbTypeId.UTINYINT,
            DuckDbTypeId.USMALLINT,
            DuckDbTypeId.UINTEGER,
            DuckDbTypeId.UBIGINT,
        ]) {
            expect(accessorFor(id)).toBe("uint64");
        }
    });

    test("maps booleans, floats and text", () => {
        expect(accessorFor(DuckDbTypeId.BOOLEAN)).toBe("boolean");
        expect(accessorFor(DuckDbTypeId.FLOAT)).toBe("double");
        expect(accessorFor(DuckDbTypeId.DOUBLE)).toBe("double");
        expect(accessorFor(DuckDbTypeId.VARCHAR)).toBe("varchar");
    });

    // Positive control (fix round 1, ruling R10): every one of these was
    // re-verified against libduckdb v1.5.5 during the fix-round-1 sweep to
    // actually render through duckdb_value_varchar - this guards against a
    // future over-eager pruning of VARCHAR_TYPES lumping the proven-good
    // types in with the eight broken ones below.
    test("reads date/time/plain-timestamp, decimal, interval and (u)hugeint columns as text", () => {
        for (const id of [
            DuckDbTypeId.DATE,
            DuckDbTypeId.TIME,
            DuckDbTypeId.TIMESTAMP,
            DuckDbTypeId.DECIMAL,
            DuckDbTypeId.HUGEINT,
            DuckDbTypeId.UHUGEINT,
            DuckDbTypeId.INTERVAL,
        ]) {
            expect(accessorFor(id)).toBe("varchar");
        }
    });

    test("refuses BLOB and the nested types", () => {
        for (const id of [
            DuckDbTypeId.BLOB,
            DuckDbTypeId.LIST,
            DuckDbTypeId.STRUCT,
            DuckDbTypeId.MAP,
            DuckDbTypeId.UNION,
            DuckDbTypeId.ARRAY,
        ]) {
            expect(accessorFor(id)).toBeNull();
        }
    });

    test("accepts the additional scalar types rendered by the napi reader", () => {
        for (const id of [
            DuckDbTypeId.TIME_TZ,
            DuckDbTypeId.TIMESTAMP_TZ,
            DuckDbTypeId.TIMESTAMP_S,
            DuckDbTypeId.TIMESTAMP_MS,
            DuckDbTypeId.TIMESTAMP_NS,
            DuckDbTypeId.UUID,
            DuckDbTypeId.ENUM,
            DuckDbTypeId.BIT,
        ]) {
            expect(accessorFor(id)).toBe("varchar");
        }
    });
});

describe("coerceValue", () => {
    test("narrows small integers to number and keeps BIGINT as bigint", () => {
        expect(coerceValue(DuckDbTypeId.INTEGER, 7n)).toBe(7);
        expect(coerceValue(DuckDbTypeId.SMALLINT, -3n)).toBe(-3);
        expect(coerceValue(DuckDbTypeId.BIGINT, 9007199254740993n)).toBe(9007199254740993n);
    });

    test("keeps BIGINT values inside the safe range as bigint for a stable row type", () => {
        expect(coerceValue(DuckDbTypeId.BIGINT, 5n)).toBe(5n);
        expect(coerceValue(DuckDbTypeId.UBIGINT, 5n)).toBe(5n);
    });

    test("passes booleans, doubles and strings through", () => {
        expect(coerceValue(DuckDbTypeId.BOOLEAN, true)).toBe(true);
        expect(coerceValue(DuckDbTypeId.DOUBLE, 1.5)).toBe(1.5);
        expect(coerceValue(DuckDbTypeId.VARCHAR, "hi")).toBe("hi");
    });

    test("turns timestamp text into a Date and leaves DATE/TIME as text", () => {
        const ts = coerceValue(DuckDbTypeId.TIMESTAMP, "2026-08-14 10:11:12.5");
        expect(ts).toBeInstanceOf(Date);
        expect((ts as Date).toISOString()).toBe("2026-08-14T10:11:12.500Z");
        expect(coerceValue(DuckDbTypeId.DATE, "2026-08-14")).toBe("2026-08-14");
        expect(coerceValue(DuckDbTypeId.TIME, "10:11:12")).toBe("10:11:12");
    });

    test("turns timestamp variants into Dates and applies TIMESTAMP_TZ offsets", () => {
        for (const id of [
            DuckDbTypeId.TIMESTAMP_S,
            DuckDbTypeId.TIMESTAMP_MS,
            DuckDbTypeId.TIMESTAMP_NS,
        ]) {
            const value = coerceValue(id, "2026-08-14 10:11:12.999999999");
            expect(value).toBeInstanceOf(Date);
            expect((value as Date).toISOString()).toBe("2026-08-14T10:11:12.999Z");
        }
        const zoned = coerceValue(DuckDbTypeId.TIMESTAMP_TZ, "2026-08-14 10:11:12+02:00");
        expect(zoned).toBeInstanceOf(Date);
        expect((zoned as Date).toISOString()).toBe("2026-08-14T08:11:12.000Z");
        const utc = coerceValue(DuckDbTypeId.TIMESTAMP_TZ, "2026-08-14 08:11:12+00");
        expect((utc as Date).toISOString()).toBe("2026-08-14T08:11:12.000Z");
    });

    test("keeps TIME_TZ, UUID, ENUM, and BIT in canonical text form", () => {
        expect(coerceValue(DuckDbTypeId.TIME_TZ, "10:11:12+02:00")).toBe("10:11:12+02:00");
        expect(coerceValue(DuckDbTypeId.UUID, "11111111-1111-1111-1111-111111111111")).toBe(
            "11111111-1111-1111-1111-111111111111",
        );
        expect(coerceValue(DuckDbTypeId.ENUM, "ready")).toBe("ready");
        expect(coerceValue(DuckDbTypeId.BIT, "1010")).toBe("1010");
    });

    // Cross-review P2-2: DuckDB keeps TIMESTAMP at MICROSECOND grain and a JS
    // `Date` is millisecond-grain, so the last three digits are dropped -
    // `.999999` becomes `.999`, and the same truncation applies to negative
    // (pre-epoch) instants. ax data is millisecond-grain, so this is the
    // accepted trade rather than a bug to fix; it is PINNED here (and stated
    // in the decoder docstring + the `DuckDbValue` docs) so it stays a
    // contract instead of an accident.
    test("truncates sub-millisecond precision, documented and pinned", () => {
        const ts = coerceValue(DuckDbTypeId.TIMESTAMP, "2026-08-14 10:11:12.999999");
        expect((ts as Date).toISOString()).toBe("2026-08-14T10:11:12.999Z");
        const before = coerceValue(DuckDbTypeId.TIMESTAMP, "1969-07-20 20:17:40.123456");
        expect((before as Date).toISOString()).toBe("1969-07-20T20:17:40.123Z");
    });

    test("leaves an unparseable timestamp as its original text rather than an Invalid Date", () => {
        expect(coerceValue(DuckDbTypeId.TIMESTAMP, "infinity")).toBe("infinity");
        expect(coerceValue(DuckDbTypeId.TIMESTAMP_TZ, "infinity")).toBe("infinity");
    });

    /**
     * `sum(BIGINT)` in DuckDB is HUGEINT, and int128 is read through the varchar
     * accessor because the FFI cannot pass 128 bits by value. Without the
     * bigint conversion the cell reached the caller's Schema as a STRING and
     * every aggregate broke: `ax cost models` / `ax cost split` died with
     * `Expected number | bigint | null, got "4274534509"`. The promotion is by
     * TYPE, not magnitude, so small fixtures could not surface it.
     */
    test("a HUGEINT arrives as text and becomes a bigint, so sum() decodes", () => {
        expect(coerceValue(DuckDbTypeId.HUGEINT, "4274534509")).toBe(4274534509n);
        expect(coerceValue(DuckDbTypeId.UHUGEINT, "10071891479")).toBe(10071891479n);
        expect(coerceValue(DuckDbTypeId.HUGEINT, "-42")).toBe(-42n);
        expect(coerceValue(DuckDbTypeId.HUGEINT, "0")).toBe(0n);
    });

    test("keeps int128 precision beyond what a JS number can hold", () => {
        // Past 2^53: converting via Number would silently round. The whole
        // point of routing this to bigint is that it cannot.
        expect(coerceValue(DuckDbTypeId.HUGEINT, "170141183460469231731687303715884105727"))
            .toBe(170141183460469231731687303715884105727n);
    });

    test("non-integer HUGEINT text keeps its raw form so the Schema fails loudly", () => {
        // Never guess. A caller's Schema rejecting a string is a typed decode
        // error naming what it found; a guessed number would be a wrong answer.
        for (const text of ["", "  ", "1.5", "1e9", "nan", "infinity", "12abc", "+7"]) {
            expect(coerceValue(DuckDbTypeId.HUGEINT, text)).toBe(text);
        }
    });

    test("does not convert integer-looking text on a genuine VARCHAR column", () => {
        // Only int128 columns get this treatment - a VARCHAR holding digits is
        // still a string (ids and hashes are stored as text).
        expect(coerceValue(DuckDbTypeId.VARCHAR, "4274534509")).toBe("4274534509");
    });
});

describe("unsupportedColumns", () => {
    test("returns only the columns with no decoder", () => {
        const columns = [
            { name: "id", typeId: DuckDbTypeId.BIGINT },
            { name: "payload", typeId: DuckDbTypeId.BLOB },
            { name: "tags", typeId: DuckDbTypeId.LIST },
        ];
        expect(unsupportedColumns(columns).map((c) => c.name)).toEqual(["payload", "tags"]);
    });
});
