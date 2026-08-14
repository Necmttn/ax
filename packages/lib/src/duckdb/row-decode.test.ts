import { describe, expect, test } from "bun:test";
import { accessorFor, coerceValue, unsupportedColumns } from "./row-decode.ts";
import { DuckDbTypeId } from "./types.ts";

describe("accessorFor", () => {
    test("maps each integer width to the widest safe row-major accessor", () => {
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

    test("refuses BLOB and the nested types (no row-major accessor exists at all)", () => {
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

    // Fix round 1 (ruling R10): empirically swept against libduckdb v1.5.5 -
    // for every one of these eight, duckdb_value_is_null correctly reports
    // false for a real (non-SQL-NULL) value, for both a bare literal and a
    // real table column, but duckdb_value_varchar STILL returns a NULL
    // char* - a different failure mode than BLOB/nested above (which have
    // no accessor at all; these DO have one, it just doesn't work). The
    // value is displayable via CAST(col AS VARCHAR) in SQL; the fixed-width
    // accessors don't rescue it either (duckdb_value_int64 returns a
    // plausible-looking 0 for all eight, with no failure signal). Before
    // this fix these all mapped to "varchar" and silently decoded to "".
    // Some of these assertions used to live in the "reads ... as text" test
    // above (TIMESTAMP_S/_MS/_NS, UUID, ENUM all asserted "varchar"); they
    // move here now that that mapping is wrong, rather than being deleted.
    test("refuses TIME_TZ, TIMESTAMP_TZ, TIMESTAMP_S/MS/NS, UUID, ENUM, BIT - duckdb_value_varchar cannot render them", () => {
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
            expect(accessorFor(id)).toBeNull();
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

    // Fix round 1 (ruling R10): TIMESTAMP_TZ is no longer in the reachable
    // set (accessorFor now excludes it entirely, see row-decode.ts's
    // VARCHAR_TYPES comment - duckdb_value_varchar can't render it, so it
    // never reaches coerceValue from the real read path). It falls through
    // to plain text, same as DATE/TIME.
    test("TIMESTAMP_TZ is no longer special-cased - accessorFor excludes it upstream, so coerceValue now treats it as opaque text like DATE/TIME", () => {
        expect(coerceValue(DuckDbTypeId.TIMESTAMP_TZ, "2026-08-14 10:11:12+02")).toBe(
            "2026-08-14 10:11:12+02",
        );
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
    });
});

describe("unsupportedColumns", () => {
    test("returns only the columns with no row-major accessor", () => {
        const columns = [
            { name: "id", typeId: DuckDbTypeId.BIGINT },
            { name: "payload", typeId: DuckDbTypeId.BLOB },
            { name: "tags", typeId: DuckDbTypeId.LIST },
        ];
        expect(unsupportedColumns(columns).map((c) => c.name)).toEqual(["payload", "tags"]);
    });
});
