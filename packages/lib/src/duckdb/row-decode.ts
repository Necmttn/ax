/**
 * Pure decode rules for the row-major `duckdb_value_*` accessors.
 *
 * `bun:ffi` cannot pass structs by value, which rules out `duckdb_fetch_chunk`
 * (it takes the 48-byte `duckdb_result` by value), so every cell is read
 * through a pointer-based `duckdb_value_*` accessor. This module holds the two
 * decisions that follow from that - WHICH accessor a column type needs, and how
 * the raw accessor result becomes a JS value - so both are testable without a
 * database.
 */
import { DuckDbTypeId, type DuckDbColumn, type DuckDbValue } from "./types.ts";

export type AccessorKind = "boolean" | "int64" | "uint64" | "double" | "varchar";

const INT64_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.TINYINT,
    DuckDbTypeId.SMALLINT,
    DuckDbTypeId.INTEGER,
    DuckDbTypeId.BIGINT,
]);

const UINT64_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.UTINYINT,
    DuckDbTypeId.USMALLINT,
    DuckDbTypeId.UINTEGER,
    DuckDbTypeId.UBIGINT,
]);

const DOUBLE_TYPES: ReadonlySet<number> = new Set([DuckDbTypeId.FLOAT, DuckDbTypeId.DOUBLE]);

/**
 * Types with no fixed-width row-major accessor that DuckDB WILL render
 * faithfully as text via `duckdb_value_varchar`: strings, date/time/plain
 * timestamp, intervals, 128-bit ints, decimal. `SQLNULL` is here too, but
 * never actually reaches the accessor - a literal SQL `NULL`'s cell always
 * reports `duckdb_value_is_null() == true`, so `readResult` takes the
 * null-cell branch before any accessor is called for it.
 *
 * EIGHT other types were empirically swept against libduckdb v1.5.5 (fix
 * round 1, ruling R10) and are DELIBERATELY EXCLUDED, for a DIFFERENT reason
 * than BLOB/nested types below (which have no row-major accessor at all):
 * for these eight, `duckdb_value_is_null` correctly reports `false` for a
 * real value, but `duckdb_value_varchar` still returns a NULL `char *` - on
 * both a bare literal and a real table column, and even though a SQL
 * `CAST(col AS VARCHAR)` on the same value renders it fine. (One caveat:
 * UUID's `duckdb_value_is_null` was also observed reporting `false` for a
 * GENUINELY NULL value under a `WHERE u IS NULL` filter - the other seven
 * were not re-swept for the same anomaly. This does not change shipped
 * behavior: UUID is rejected earlier, structurally, at `unsupportedColumns`
 * below, so `readResult`'s per-cell `is_null` check is never reached for it
 * at all.) The fixed-width
 * accessors don't rescue them either: `duckdb_value_int64` was checked and
 * returns a plausible-looking `0` for every one of them, with no failure
 * signal at all - so none of these should ever be routed to
 * `int64`/`uint64`/`double` as a workaround. Before this fix, the NULL
 * varchar pointer silently decoded to `""` for all eight. A future reader:
 * do not try to "fix" this by giving these an accessor again without first
 * re-verifying against whatever libduckdb build is in use.
 *
 *   TIME_TZ (30), TIMESTAMP_TZ (31), TIMESTAMP_S (20), TIMESTAMP_MS (21),
 *   TIMESTAMP_NS (22), UUID (27), ENUM (23), BIT (29)
 *
 * `client.ts`'s `readResult` also carries a general guard for this exact
 * failure shape (not-null cell, NULL varchar pointer) on any type still
 * listed here as "varchar" - it is what would have caught these eight
 * before they shipped, and is what will catch whatever DuckDB adds next.
 */
const VARCHAR_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.VARCHAR,
    DuckDbTypeId.DATE,
    DuckDbTypeId.TIME,
    DuckDbTypeId.TIMESTAMP,
    DuckDbTypeId.INTERVAL,
    DuckDbTypeId.HUGEINT,
    DuckDbTypeId.UHUGEINT,
    DuckDbTypeId.DECIMAL,
    DuckDbTypeId.SQLNULL,
]);

/** Which `duckdb_value_*` accessor reads this column, or null when none can. */
export const accessorFor = (typeId: number): AccessorKind | null => {
    if (typeId === DuckDbTypeId.BOOLEAN) return "boolean";
    if (INT64_TYPES.has(typeId)) return "int64";
    if (UINT64_TYPES.has(typeId)) return "uint64";
    if (DOUBLE_TYPES.has(typeId)) return "double";
    if (VARCHAR_TYPES.has(typeId)) return "varchar";
    return null;
};

/**
 * DuckDB prints a `TIMESTAMP` (offset-free, means UTC here) as
 * `YYYY-MM-DD HH:MM:SS[.ffffff]`, so this just replaces the space with `T`
 * and appends `Z`. `TIMESTAMP` never renders an existing `Z` suffix or an
 * explicit offset - `TIMESTAMP_TZ` is the type that would have, and it is
 * excluded upstream entirely (fix round 1; see the comment on
 * `VARCHAR_TYPES`) - so this is the only type ever routed here, and it is
 * the only shape this function needs to handle.
 */
const parseTimestamp = (text: string): Date | string =>
    finishTimestamp(`${text.replace(" ", "T")}Z`, text);

/**
 * Parse `iso`; fall back to `original` text rather than an Invalid Date.
 *
 * PRECISION IS LOST HERE, DELIBERATELY (cross-review P2-2). DuckDB stores
 * `TIMESTAMP` at MICROSECOND grain and renders all six digits; a JS `Date`
 * holds whole MILLISECONDS, so `new Date(...)` TRUNCATES the last three:
 * `2026-08-14 10:11:12.999999` comes back as `...12.999Z`, and the same
 * applies to pre-epoch instants (truncation toward the millisecond boundary
 * `Date` can represent, never a rounding). Nothing warns; the value simply
 * loses its tail.
 *
 * This is accepted, not overlooked: every ax timestamp is millisecond-grain
 * (JS `Date.now()`, transcript timestamps, OTLP millis), so the truncated
 * digits carry no information ax ever wrote, and a `Date` is what every
 * caller and every `Schema` in this repo expects. A caller that genuinely
 * needs microsecond fidelity must NOT read the column as `TIMESTAMP` - it
 * should project it in SQL (`CAST(ts AS VARCHAR)`, or `epoch_us(ts)` for an
 * exact integer) and keep the text/bigint. The behavior is pinned by a test
 * in row-decode.test.ts so it stays a contract rather than an accident.
 */
const finishTimestamp = (iso: string, original: string): Date | string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? original : date;
};

/** Raw accessor output -> the JS value callers see. */
export const coerceValue = (
    typeId: number,
    raw: boolean | bigint | number | string,
): DuckDbValue => {
    if (typeof raw === "string") {
        return typeId === DuckDbTypeId.TIMESTAMP ? parseTimestamp(raw) : raw;
    }
    if (typeof raw === "bigint") {
        // 64-bit columns stay bigint so a row's TS type never depends on the
        // magnitude of the value it happens to hold. Narrower widths cannot
        // overflow a JS number, so they come back as number.
        if (typeId === DuckDbTypeId.BIGINT || typeId === DuckDbTypeId.UBIGINT) return raw;
        return Number(raw);
    }
    return raw;
};

/** Result columns this client cannot decode. */
export const unsupportedColumns = (
    columns: ReadonlyArray<DuckDbColumn>,
): ReadonlyArray<DuckDbColumn> => columns.filter((c) => accessorFor(c.typeId) === null);
