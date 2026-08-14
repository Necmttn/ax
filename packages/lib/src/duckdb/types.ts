/**
 * `duckdb_type` enum values from duckdb.h (v1.5.5). Only the ids this client
 * can decode are named; anything else surfaces as a raw number in
 * `DuckDbUnsupportedTypeError`.
 */
export const DuckDbTypeId = {
    INVALID: 0,
    BOOLEAN: 1,
    TINYINT: 2,
    SMALLINT: 3,
    INTEGER: 4,
    BIGINT: 5,
    UTINYINT: 6,
    USMALLINT: 7,
    UINTEGER: 8,
    UBIGINT: 9,
    FLOAT: 10,
    DOUBLE: 11,
    TIMESTAMP: 12,
    DATE: 13,
    TIME: 14,
    INTERVAL: 15,
    HUGEINT: 16,
    VARCHAR: 17,
    BLOB: 18,
    DECIMAL: 19,
    TIMESTAMP_S: 20,
    TIMESTAMP_MS: 21,
    TIMESTAMP_NS: 22,
    ENUM: 23,
    LIST: 24,
    STRUCT: 25,
    MAP: 26,
    UUID: 27,
    UNION: 28,
    BIT: 29,
    TIME_TZ: 30,
    TIMESTAMP_TZ: 31,
    UHUGEINT: 32,
    ARRAY: 33,
    SQLNULL: 36,
} as const;

export type DuckDbTypeId = (typeof DuckDbTypeId)[keyof typeof DuckDbTypeId];

/** Human name for a duckdb type id, for error messages. */
export const duckDbTypeName = (id: number): string =>
    Object.entries(DuckDbTypeId).find(([, v]) => v === id)?.[0] ?? `TYPE_${id}`;

/** Every JS value a decoded cell can take. */
export type DuckDbValue = string | number | bigint | boolean | Date | null;

export type DuckDbRow = Readonly<Record<string, DuckDbValue>>;

export interface DuckDbColumn {
    readonly name: string;
    readonly typeId: number;
}

export interface QueryResult {
    readonly columns: ReadonlyArray<DuckDbColumn>;
    readonly rows: ReadonlyArray<DuckDbRow>;
    /** Rows changed by a DML statement; 0 for SELECTs. */
    readonly rowsChanged: number;
}

/** Values accepted as prepared-statement parameters. */
export type DuckDbParam = string | number | bigint | boolean | Date | null | undefined;
