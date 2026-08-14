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
 * this client can't decode `typeId`: BLOB and the nested types have no
 * row-major accessor at all, while `TIME_TZ`/`TIMESTAMP_TZ` (and, as of fix
 * round 1, several other types - see the comment on `VARCHAR_TYPES` in
 * row-decode.ts) DO have an accessor kind assigned but the underlying
 * `duckdb_value_varchar` call fails for them regardless - `CAST(col AS
 * VARCHAR)` is the one workaround proven to render every case tried so far.
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
 * A result column has a type this client cannot read through the row-major
 * `duckdb_value_*` API. Two distinct reasons land here: BLOB and the nested
 * types have no pointer-based accessor at all; TIME_TZ/TIMESTAMP_TZ and
 * several other types (fix round 1 - see `VARCHAR_TYPES` in row-decode.ts)
 * DO have an accessor assigned but `duckdb_value_varchar` fails for them
 * regardless. Project the column in SQL instead - `hex(col)` / `to_json(col)`
 * / `CAST(col AS VARCHAR)`, depending on which.
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

/** Another process holds the ingest lock. Carries who, so the CLI can say so. */
export class IngestLockHeldError extends Schema.TaggedErrorClass<IngestLockHeldError>(
    "IngestLockHeldError",
)("IngestLockHeldError", {
    path: Schema.String,
    pid: Schema.Number,
    startedAt: Schema.String,
}) {}

/** The lock file itself could not be read/written (permissions, bad dir, ...). */
export class IngestLockError extends Schema.TaggedErrorClass<IngestLockError>(
    "IngestLockError",
)("IngestLockError", {
    path: Schema.String,
    message: Schema.String,
}) {}

/** Snapshot publication failed before the atomic rename landed. */
export class SnapshotPublishError extends Schema.TaggedErrorClass<SnapshotPublishError>(
    "SnapshotPublishError",
)("SnapshotPublishError", {
    snapshotPath: Schema.String,
    message: Schema.String,
}) {}
