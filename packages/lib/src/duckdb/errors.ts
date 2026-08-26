import { Schema } from "effect";
import { DuckDbTypeId, duckDbTypeName } from "./types.ts";

const NESTED_TYPES: ReadonlySet<number> = new Set([
    DuckDbTypeId.LIST,
    DuckDbTypeId.STRUCT,
    DuckDbTypeId.MAP,
    DuckDbTypeId.UNION,
    DuckDbTypeId.ARRAY,
]);

/**
 * The SQL to suggest projecting the column through instead, tailored to WHY
 * this client cannot decode `typeId`. BLOB needs a hexadecimal projection.
 * Nested types need JSON. Unknown future types use a text cast.
 */
const workaroundFor = (typeId: number, column: string): string => {
    if (typeId === DuckDbTypeId.BLOB) return `hex(${column})`;
    if (NESTED_TYPES.has(typeId)) return `to_json(${column})`;
    return `CAST(${column} AS VARCHAR)`;
};

/** `duckdb_open` / `duckdb_open_ext` / `duckdb_connect` failure. */
export class DuckDbOpenError extends Schema.TaggedErrorClass<DuckDbOpenError>(
    "DuckDbOpenError",
)("DuckDbOpenError", {
    path: Schema.String,
    readOnly: Schema.Boolean,
    message: Schema.String,
}) {}

/** A statement failed to prepare, bind, or execute. `sql` is a short excerpt. */
export class DuckDbQueryError extends Schema.TaggedErrorClass<DuckDbQueryError>(
    "DuckDbQueryError",
)("DuckDbQueryError", {
    sql: Schema.String,
    message: Schema.String,
}) {}

/** Rows came back fine but did not match the caller's schema. */
export class DuckDbDecodeError extends Schema.TaggedErrorClass<DuckDbDecodeError>(
    "DuckDbDecodeError",
)("DuckDbDecodeError", {
    sql: Schema.String,
    message: Schema.String,
}) {}

/**
 * A result column has a type outside the client's closed decode contract.
 * Project it with `hex`, `to_json`, or `CAST`, depending on its type.
 */
export class DuckDbUnsupportedTypeError extends Schema.TaggedErrorClass<DuckDbUnsupportedTypeError>(
    "DuckDbUnsupportedTypeError",
)("DuckDbUnsupportedTypeError", {
    column: Schema.String,
    typeId: Schema.Number,
}) {
    override get message(): string {
        const name = duckDbTypeName(this.typeId);
        return `column "${this.column}" has type ${name}, which this client cannot decode; project it in SQL instead (e.g. ${workaroundFor(this.typeId, this.column)})`;
    }
}

/** The libduckdb shared library could not be located, extracted, or opened. */
export class DuckDbDylibError extends Schema.TaggedErrorClass<DuckDbDylibError>(
    "DuckDbDylibError",
)("DuckDbDylibError", {
    message: Schema.String,
}) {}

// The ingest lock's failures are NOT here. It reports contention as an OUTCOME
// (`IngestLockOutcome` in `@ax/lib/ingest-lock`), not an error, because a busy
// skip is the correct, expected result of a second ingest - the watcher re-fires
// anyway - and modelling it as a failure made every caller unwrap it back into a
// success. The two error classes that used to live here had no callers left once
// the two lock implementations merged.

/** Snapshot publication failed before the atomic rename landed. */
export class SnapshotPublishError extends Schema.TaggedErrorClass<SnapshotPublishError>(
    "SnapshotPublishError",
)("SnapshotPublishError", {
    snapshotPath: Schema.String,
    message: Schema.String,
}) {}
