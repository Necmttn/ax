/**
 * The `DuckDb` service: open a database, run queries/exec through it, and
 * close it. Everything downstream in the v2 architecture reads and writes
 * through this module, so its two jobs are non-negotiable: never leak a
 * native allocation, and never turn a missing/corrupt database into a silent
 * empty result.
 *
 * Layered on top of ffi.ts's raw symbol table (see that module's docstring
 * for the handle-convention gotchas) and row-decode.ts's pure accessor/coerce
 * rules. This module owns:
 *   - the open/connect/close lifecycle, including the config dance needed to
 *     force read-only mode and the guard that refuses to silently create a
 *     database when a read-only caller expected one to already exist,
 *   - translating every C-level failure into one of this package's tagged
 *     errors (`DuckDbOpenError` / `DuckDbQueryError` / `DuckDbUnsupportedTypeError`),
 *   - the parameter-binding dispatch for prepared statements,
 *   - freeing every `duckdb_value_varchar` pointer and every `duckdb_result` /
 *     `duckdb_prepared_statement` handle, on every path (success, SQL error,
 *     decode error) via `try/finally`.
 *
 * RULING R6: this is a runtime module under `packages/lib/src/`, so
 * `node:fs` / `node:path` are banned (`check:no-node-fs`). The read-only
 * existence guard goes through `FileSystem.FileSystem`, acquired once in the
 * layer and closed over by every service/connection method - so every method
 * below keeps `R = never`, exactly as the interfaces declare. `node:os`
 * `homedir()` is not banned, and `snapshotPath()`'s default
 * (`~/.ax/cache/ax-snapshot.duckdb`) uses it. `bun:ffi` is fine - this module
 * is Bun-only regardless.
 */
import { ptr } from "bun:ffi";
import { BunFileSystem } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Schema, type Scope } from "effect";
import { homedir } from "node:os";
import { posixPath } from "../shared/path.ts";
import { canonicalPath } from "./canonical-path.ts";
import { resolveDylibPath } from "./dylib.ts";
import {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
    SnapshotPublishError,
} from "./errors.ts";
import {
    cstr,
    DUCKDB_RESULT_SIZE,
    DUCKDB_SUCCESS,
    handleBuffer,
    openLibDuckDb,
    readCString,
    type LibDuckDb,
} from "./ffi.ts";
import { accessorFor, coerceValue, unsupportedColumns } from "./row-decode.ts";
import type { DuckDbColumn, DuckDbParam, DuckDbRow, DuckDbValue, QueryResult } from "./types.ts";

export interface DuckDbConnection {
    readonly path: string;
    readonly readOnly: boolean;
    readonly query: (
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<QueryResult, DuckDbQueryError | DuckDbUnsupportedTypeError>;
    readonly queryAs: <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<
        ReadonlyArray<S["Type"]>,
        DuckDbQueryError | DuckDbUnsupportedTypeError | DuckDbDecodeError,
        S["DecodingServices"]
    >;
    readonly exec: (
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<number, DuckDbQueryError | DuckDbUnsupportedTypeError>;
    readonly close: Effect.Effect<void>;
}

export interface DuckDbService {
    readonly open: (
        path: string,
        options?: { readonly readOnly?: boolean },
    ) => Effect.Effect<DuckDbConnection, DuckDbOpenError>;
    readonly scoped: (
        path: string,
        options?: { readonly readOnly?: boolean },
    ) => Effect.Effect<DuckDbConnection, DuckDbOpenError, Scope.Scope>;
    /**
     * Copy `livePath`'s current contents to `snapshotPath` via an atomic
     * rename - readers holding the previous snapshot keep reading it
     * uninterrupted until they reopen. See the docstring above
     * `makeService`'s `publishSnapshot` for the mechanism, and RULING R14
     * (same docstring) for why `options.from` is load-bearing whenever a
     * writer on `livePath` is already open in this process.
     */
    readonly publishSnapshot: (
        livePath: string,
        snapshotPath: string,
        options?: { readonly from?: DuckDbConnection },
    ) => Effect.Effect<void, SnapshotPublishError | DuckDbOpenError>;
    /** Open a published snapshot read-only. Defaults to {@link snapshotPath}. */
    readonly openSnapshot: (snapshotPath?: string) => Effect.Effect<DuckDbConnection, DuckDbOpenError>;
    /** `AX_DUCKDB_SNAPSHOT`, or `~/.ax/cache/ax-snapshot.duckdb`. Pure - same
     *  value as the module-level {@link snapshotPath} export. */
    readonly snapshotPath: () => string;
}

/** `AX_DUCKDB_SNAPSHOT`, or `~/.ax/cache/ax-snapshot.duckdb` - mirrors the
 *  `AX_DATA_DIR`-less default used by `dylib.ts`/`lock.ts`. */
export const snapshotPath = (): string => {
    const override = process.env.AX_DUCKDB_SNAPSHOT?.trim();
    return override ? override : posixPath.join(homedir(), ".ax", "cache", "ax-snapshot.duckdb");
};

/** First 200 chars of a statement, mirroring `packages/lib/src/db.ts`'s
 *  `sqlExcerpt` - every `DuckDbQueryError`/`DuckDbDecodeError` uses it so a
 *  huge statement never bloats the error. */
const SQL_EXCERPT_LEN = 200;
const sqlExcerpt = (sql: string): string =>
    sql.length > SQL_EXCERPT_LEN ? `${sql.slice(0, SQL_EXCERPT_LEN)}…` : sql;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** True for a null/zero pointer - both the `Pointer` shape from a
 *  `PTR`-typed return and the `bigint` shape read out of a `BigUint64Array`
 *  out-param show up here. */
const isNullPointer = (p: number | bigint | null | undefined): boolean =>
    p === null || p === undefined || p === 0 || p === 0n;

/** Free a `char *` this client owns, tolerating a null pointer. */
const duckdbFree = (lib: LibDuckDb, p: number | bigint | null | undefined): void => {
    if (isNullPointer(p)) return;
    lib.symbols.duckdb_free(Number(p) as never);
};

/**
 * Open the database file and connect. Always builds a `duckdb_config` (even
 * for a read-write open) so the read-only branch is just one extra
 * `duckdb_set_config` call; the config is always destroyed before returning,
 * on every path. Throws `DuckDbOpenError` - the caller (`makeService.open`)
 * wraps this in `Effect.try`.
 *
 * The "does the file already exist" check for a read-only open happens
 * BEFORE this is called (in the effectful `open`, via `FileSystem`) rather
 * than here, so this function can stay a plain sync throw-on-failure helper
 * with no `R` channel to thread through.
 */
// Exported (not part of the DuckDbService product surface) so the P3-1
// config-destruction guarantee can be unit-tested against a fake LibDuckDb -
// a failing `duckdb_create_config` cannot be provoked through a real dylib.
export const openDatabase = (
    lib: LibDuckDb,
    path: string,
    readOnly: boolean,
): { readonly dbBuf: BigUint64Array; readonly connBuf: BigUint64Array } => {
    const cfgBuf = handleBuffer();
    const createState = lib.symbols.duckdb_create_config(ptr(cfgBuf));
    if (createState !== DUCKDB_SUCCESS) {
        // Cross-review P3-1: duckdb.h (v1.5.5, lines 1018-1023) documents
        // that `duckdb_destroy_config` must run even when creation FAILS -
        // the out-param can already hold a partially-initialised config. The
        // throw used to skip it, leaking that allocation on every failure.
        lib.symbols.duckdb_destroy_config(ptr(cfgBuf));
        throw new DuckDbOpenError({ path, readOnly, message: "duckdb_create_config failed" });
    }

    if (readOnly) {
        const setState = lib.symbols.duckdb_set_config(
            cfgBuf[0]!,
            cstr("access_mode"),
            cstr("READ_ONLY"),
        );
        if (setState !== DUCKDB_SUCCESS) {
            lib.symbols.duckdb_destroy_config(ptr(cfgBuf));
            throw new DuckDbOpenError({
                path,
                readOnly,
                message: "duckdb_set_config(access_mode, READ_ONLY) failed",
            });
        }
    }

    const dbBuf = handleBuffer();
    const errBuf = handleBuffer();
    const openState = lib.symbols.duckdb_open_ext(cstr(path), ptr(dbBuf), cfgBuf[0]!, ptr(errBuf));
    // Always destroyed, on both the success and failure path.
    lib.symbols.duckdb_destroy_config(ptr(cfgBuf));

    if (openState !== DUCKDB_SUCCESS) {
        const message = readCString(errBuf[0]) ?? "duckdb_open_ext failed with no message";
        duckdbFree(lib, errBuf[0]);
        throw new DuckDbOpenError({ path, readOnly, message });
    }

    const connBuf = handleBuffer();
    const connectState = lib.symbols.duckdb_connect(dbBuf[0]!, ptr(connBuf));
    if (connectState !== DUCKDB_SUCCESS) {
        lib.symbols.duckdb_close(ptr(dbBuf));
        throw new DuckDbOpenError({ path, readOnly, message: "duckdb_connect failed" });
    }

    return { dbBuf, connBuf };
};

/**
 * The inclusive bounds of DuckDB's `BIGINT` / C `int64_t`, which is the only
 * integer width `duckdb_bind_int64` (the sole integer bind this client binds)
 * can carry.
 */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * Cross-review P1-2: every `bigint` parameter went straight to
 * `duckdb_bind_int64`, and `bun:ffi`'s `i64` marshalling WRAPS silently -
 * `2n**63n` was reproduced arriving as `-2n**63n`, and `2n**100n` as `0n`.
 * Corrupt data with no signal is the worst failure mode a store can have, so
 * an out-of-range value is refused BEFORE it reaches the FFI boundary. The
 * caller keeps the exact value in the message, plus the limit it broke, so
 * the fix (store it as VARCHAR/HUGEINT text) is obvious from the error alone.
 */
export const bindableBigInt = (value: bigint): boolean => value >= I64_MIN && value <= I64_MAX;

const bigintRangeMessage = (idx: number, value: bigint): string =>
    `parameter ${idx} (${value}) is outside the range this client can bind: DuckDB binds integers as a signed 64-bit int64 (${I64_MIN} to ${I64_MAX}), and a wider value would silently wrap. Pass it as text (and store the column as VARCHAR or HUGEINT) instead.`;

/** Bind one prepared-statement parameter (1-based `idx`). Returns the
 *  `duckdb_state` from the underlying bind call so the caller can check it. */
const bindParam = (lib: LibDuckDb, stmtHandle: bigint, idx: bigint, param: DuckDbParam): number => {
    if (param === null || param === undefined) return lib.symbols.duckdb_bind_null(stmtHandle, idx);
    if (typeof param === "boolean") return lib.symbols.duckdb_bind_boolean(stmtHandle, idx, param);
    if (typeof param === "bigint") return lib.symbols.duckdb_bind_int64(stmtHandle, idx, param);
    if (typeof param === "number") {
        return Number.isSafeInteger(param)
            ? lib.symbols.duckdb_bind_int64(stmtHandle, idx, BigInt(param))
            : lib.symbols.duckdb_bind_double(stmtHandle, idx, param);
    }
    if (param instanceof Date) {
        return lib.symbols.duckdb_bind_varchar(stmtHandle, idx, cstr(param.toISOString()));
    }
    return lib.symbols.duckdb_bind_varchar(stmtHandle, idx, cstr(param));
};

/** Read the borrowed (result-owned) error message off a just-failed result,
 *  destroy the result, and build the typed failure. */
const queryError = (
    lib: LibDuckDb,
    sql: string,
    resultPtr: ReturnType<typeof ptr>,
): DuckDbQueryError => {
    const message = readCString(lib.symbols.duckdb_result_error(resultPtr)) ?? "query failed with no message";
    lib.symbols.duckdb_destroy_result(resultPtr);
    return new DuckDbQueryError({ sql: sqlExcerpt(sql), message });
};

/**
 * Run one statement (query or prepared+bound+execute) and hand back the raw
 * result buffer. Throws `DuckDbQueryError`. The prepared statement, when one
 * is created, is always destroyed in a `finally` - on the bind-failure,
 * execute-failure, and success paths alike.
 */
const runStatement = (
    lib: LibDuckDb,
    connHandle: bigint,
    sql: string,
    params: ReadonlyArray<DuckDbParam>,
): { readonly resultPtr: ReturnType<typeof ptr>; readonly resultBuf: Uint8Array } => {
    const resultBuf = new Uint8Array(DUCKDB_RESULT_SIZE);
    const resultPtr = ptr(resultBuf);

    if (params.length === 0) {
        const state = lib.symbols.duckdb_query(connHandle, cstr(sql), resultPtr);
        if (state !== DUCKDB_SUCCESS) throw queryError(lib, sql, resultPtr);
        return { resultPtr, resultBuf };
    }

    const stmtBuf = handleBuffer();
    const prepareState = lib.symbols.duckdb_prepare(connHandle, cstr(sql), ptr(stmtBuf));
    if (prepareState !== DUCKDB_SUCCESS) {
        const message =
            readCString(lib.symbols.duckdb_prepare_error(stmtBuf[0]!)) ??
            "duckdb_prepare failed with no message";
        lib.symbols.duckdb_destroy_prepare(ptr(stmtBuf));
        throw new DuckDbQueryError({ sql: sqlExcerpt(sql), message });
    }

    try {
        const stmtHandle = stmtBuf[0]!;
        for (let i = 0; i < params.length; i += 1) {
            const param = params[i];
            if (typeof param === "bigint" && !bindableBigInt(param)) {
                throw new DuckDbQueryError({
                    sql: sqlExcerpt(sql),
                    message: bigintRangeMessage(i + 1, param),
                });
            }
            const bindState = bindParam(lib, stmtHandle, BigInt(i + 1), params[i]);
            if (bindState !== DUCKDB_SUCCESS) {
                throw new DuckDbQueryError({
                    sql: sqlExcerpt(sql),
                    message: `failed to bind parameter ${i + 1}`,
                });
            }
        }

        const execState = lib.symbols.duckdb_execute_prepared(stmtHandle, resultPtr);
        if (execState !== DUCKDB_SUCCESS) throw queryError(lib, sql, resultPtr);
    } finally {
        lib.symbols.duckdb_destroy_prepare(ptr(stmtBuf));
    }

    return { resultPtr, resultBuf };
};

/**
 * Decode a successful result into `QueryResult`. Throws
 * `DuckDbUnsupportedTypeError` for the FIRST undecodable column BEFORE
 * reading any cell - a BLOB (or other unsupported) column must never let a
 * garbage value through. Every `duckdb_value_varchar` pointer is freed in a
 * `try/finally` immediately wrapping `readCString`, on every row - freeing
 * happens whether or not decoding the string itself throws, by construction
 * rather than by the two calls merely sitting next to each other.
 *
 * Fix round 1 (ruling R10, Part B): a column can pass the structural
 * `unsupportedColumns` check above (it has an accessor kind) and STILL fail
 * per-cell - `duckdb_value_varchar` returns a NULL `char *` for a handful of
 * types (`TIME_TZ`/`TIMESTAMP_TZ` confirmed, plus `TIMESTAMP_S`/`_MS`/`_NS`,
 * `UUID`, `ENUM`, `BIT` in this dylib build - see the comment on
 * `VARCHAR_TYPES` in row-decode.ts) even though `duckdb_value_is_null`
 * reports the cell is NOT SQL NULL. That combination - not-null cell, NULL
 * varchar pointer - is an ACCESSOR FAILURE, not an empty string and not a
 * real NULL, so it raises `DuckDbUnsupportedTypeError` naming the column
 * instead of silently decoding to `""`. This is the general guard: it is
 * what would have caught `TIMESTAMP_TZ` before it shipped, and it is what
 * catches every other type in the list above today plus whatever DuckDB
 * adds next. It keys on duckdb.h's own documented contract for
 * `duckdb_value_varchar` (duckdb.h:1579-1581): "returns the char* value...
 * NULL if the value cannot be converted" - the NULL return IS the failure
 * signal, not an implementation quirk being worked around.
 *
 * Fix round 2 (ruling R11) - KNOWN, UNFIXED LIMITATION: `duckdb_value_varchar`
 * returns a plain NUL-terminated `char *` with no accompanying length, and
 * `readCString` (ffi.ts) decodes it with `new CString(ptr)`, which stops at
 * the first NUL byte. A VARCHAR value containing an embedded NUL byte (e.g.
 * `SELECT 'a' || chr(0) || 'b'`) is silently TRUNCATED to `"a"` - no error,
 * no signal, on the load-bearing read path every v2 caller uses. This is NOT
 * fixable within this design: the length-carrying accessor
 * (`duckdb_value_string`, returning `duckdb_string { char *data; idx_t size;
 * }`) returns that struct BY VALUE, which `bun:ffi` cannot express (no
 * struct-typed `FFIType` exists at all - the same constraint already
 * documented in ffi.ts for `duckdb_fetch_chunk`/`duckdb_result`). Callers
 * storing arbitrary text (e.g. JSON transcripts, which can carry `\0`)
 * through this client must reject or escape NUL bytes before writing, since
 * this client cannot detect the truncation on the way back out.
 */
// Exported (not part of the DuckDbService/DuckDbConnection product surface)
// so fix round 1's Part B guard can be unit-tested directly against a fake
// LibDuckDb: Part A now excludes every currently-known trigger of the guard
// from VARCHAR_TYPES structurally, so no real SQL type reaches it any more -
// see client.test.ts.
export const readResult = (
    lib: LibDuckDb,
    resultPtr: ReturnType<typeof ptr>,
    sql = "",
): QueryResult => {
    const columnCount = Number(lib.symbols.duckdb_column_count(resultPtr));
    const columns: DuckDbColumn[] = [];
    for (let c = 0; c < columnCount; c += 1) {
        const idx = BigInt(c);
        const name = readCString(lib.symbols.duckdb_column_name(resultPtr, idx)) ?? `column_${c}`;
        const typeId = lib.symbols.duckdb_column_type(resultPtr, idx);
        columns.push({ name, typeId });
    }

    // Cross-review P2-1, half one: a row is keyed BY COLUMN NAME, so two
    // columns sharing a name (`SELECT a.v, b.v FROM a, b` - DuckDB permits
    // it) used to overwrite each other and hand the caller one value where it
    // asked for two. That is silent data loss on a read path, so it is a
    // typed refusal naming the fix.
    const duplicate = columns.find((c, i) => columns.findIndex((o) => o.name === c.name) !== i);
    if (duplicate !== undefined) {
        throw new DuckDbQueryError({
            sql: sqlExcerpt(sql),
            message: `the result has more than one column named "${duplicate.name}"; rows are keyed by column name, so alias them (e.g. SELECT a.${duplicate.name} AS a_${duplicate.name}, b.${duplicate.name} AS b_${duplicate.name}) to keep both values`,
        });
    }

    const unsupported = unsupportedColumns(columns);
    if (unsupported.length > 0) {
        const first = unsupported[0]!;
        throw new DuckDbUnsupportedTypeError({ column: first.name, typeId: first.typeId });
    }

    // Hoisted out of the row loop: every column's accessor kind is invariant
    // across rows, and `unsupportedColumns` above already proved none is null.
    const columnKinds = columns.map((c) => accessorFor(c.typeId));

    const rowCount = Number(lib.symbols.duckdb_row_count(resultPtr));
    const rows: DuckDbRow[] = [];
    for (let r = 0; r < rowCount; r += 1) {
        const rowIdx = BigInt(r);
        // Cross-review P2-1, half two: on a normal `{}` the assignment
        // `row["__proto__"] = v` hits Object.prototype's `__proto__` SETTER,
        // which ignores a non-object value - so a `__proto__` column silently
        // vanished from every row. A null-prototype object has no inherited
        // accessors at all, so every column name (`__proto__`, `constructor`,
        // `toString`) round-trips as plain data.
        const row: Record<string, DuckDbValue> = Object.create(null) as Record<string, DuckDbValue>;
        for (let c = 0; c < columnCount; c += 1) {
            const colIdx = BigInt(c);
            const column = columns[c]!;

            if (lib.symbols.duckdb_value_is_null(resultPtr, colIdx, rowIdx)) {
                row[column.name] = null;
                continue;
            }

            const kind = columnKinds[c];
            let raw: boolean | bigint | number | string;
            switch (kind) {
                case "boolean":
                    raw = lib.symbols.duckdb_value_boolean(resultPtr, colIdx, rowIdx);
                    break;
                case "int64":
                    raw = lib.symbols.duckdb_value_int64(resultPtr, colIdx, rowIdx);
                    break;
                case "uint64":
                    raw = lib.symbols.duckdb_value_uint64(resultPtr, colIdx, rowIdx);
                    break;
                case "double":
                    raw = lib.symbols.duckdb_value_double(resultPtr, colIdx, rowIdx);
                    break;
                case "varchar": {
                    const strPtr = lib.symbols.duckdb_value_varchar(resultPtr, colIdx, rowIdx);
                    if (isNullPointer(strPtr)) {
                        // duckdb_value_is_null already said this cell is NOT
                        // SQL NULL, so a NULL char* here means the row-major
                        // accessor cannot render this type at all - see the
                        // fix-round-1 note on this function.
                        throw new DuckDbUnsupportedTypeError({
                            column: column.name,
                            typeId: column.typeId,
                        });
                    }
                    try {
                        raw = readCString(strPtr) ?? "";
                    } finally {
                        duckdbFree(lib, strPtr);
                    }
                    break;
                }
                default:
                    // unreachable: unsupportedColumns() above already excluded
                    // every column whose accessorFor() is null.
                    throw new DuckDbUnsupportedTypeError({ column: column.name, typeId: column.typeId });
            }
            row[column.name] = coerceValue(column.typeId, raw);
        }
        rows.push(row);
    }

    const rowsChanged = Number(lib.symbols.duckdb_rows_changed(resultPtr));
    return { columns, rows, rowsChanged };
};

// Exported (not part of the DuckDbService/DuckDbConnection product surface,
// same rationale as readResult above) so fix round 2's close/idempotency
// tests can drive a connection against a fake LibDuckDb and count
// duckdb_disconnect/duckdb_close calls directly, instead of relying on an
// indirect, unreliable proxy (a read-only reopen of the same path does NOT
// prove the write handle was released - opening a path read-only while a
// write handle is still open on it succeeds against this dylib).
/** Build the `DuckDbConnection` for one open database handle. */
export const makeConnection = (
    lib: LibDuckDb,
    path: string,
    readOnly: boolean,
    dbBuf: BigUint64Array,
    connBuf: BigUint64Array,
): DuckDbConnection => {
    const connHandle = connBuf[0]!;
    let closed = false;

    /** Run `sql`, always destroying the native result exactly once, whether
     *  decoding succeeds, fails with `DuckDbUnsupportedTypeError`, or a lower
     *  layer throws something unexpected. */
    const runQuery = (sql: string, params: ReadonlyArray<DuckDbParam>): QueryResult => {
        // `resultBuf` is bound (not discarded) so it stays a live local
        // reference for the duration of this call - `resultPtr` is a raw
        // address into its backing store, so the buffer must outlive every
        // use of that address. Never read directly; it exists to be held.
        const { resultPtr, resultBuf } = runStatement(lib, connHandle, sql, params);
        try {
            return readResult(lib, resultPtr, sql);
        } finally {
            lib.symbols.duckdb_destroy_result(resultPtr);
            void resultBuf;
        }
    };

    /**
     * Cross-review P1-1: `connHandle` is captured ONCE, above, and `close`
     * frees the database and connection behind it - so every operation issued
     * after `close` handed a DANGLING pointer to libduckdb. That is not a
     * catchable error: it was reproduced as a Bun SEGMENTATION FAULT, the
     * process gone with no stack, no Effect failure, and nothing written to
     * the caller's log. Use-after-close is a caller bug either way, but this
     * client's job is to make it a typed failure the caller can see, so every
     * operation re-checks the flag first and NO native symbol is reached.
     *
     * `Effect.suspend` matters: the check has to run when the effect RUNS,
     * not when it is built - a `query(...)` value constructed before `close`
     * and run after it must still refuse.
     */
    const refuseIfClosed = (sql: string): Effect.Effect<never, DuckDbQueryError> =>
        Effect.fail(
            new DuckDbQueryError({
                sql: sqlExcerpt(sql),
                message: `the connection to ${path} is closed; open a new one (a statement on a closed connection would dereference a freed native handle)`,
            }),
        );

    const query: DuckDbConnection["query"] = (sql, params = []) =>
        Effect.suspend(() =>
            closed
                ? refuseIfClosed(sql)
                : Effect.try({
                      try: () => runQuery(sql, params),
                      catch: (err) =>
                          err instanceof DuckDbQueryError || err instanceof DuckDbUnsupportedTypeError
                              ? err
                              : new DuckDbQueryError({ sql: sqlExcerpt(sql), message: errorMessage(err) }),
                  }),
        );

    // `exec` and `queryAs` both run THROUGH `query`, so the closed-connection
    // guard above covers all three - there is no second path to the native
    // handle to forget.
    const exec: DuckDbConnection["exec"] = (sql, params = []) =>
        Effect.map(query(sql, params), (result) => result.rowsChanged);

    const queryAs: DuckDbConnection["queryAs"] = (schema, sql, params) =>
        query(sql, params).pipe(
            Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Schema.Array(schema))(result.rows).pipe(
                    Effect.mapError(
                        (issue) => new DuckDbDecodeError({ sql: sqlExcerpt(sql), message: issue.message }),
                    ),
                ),
            ),
        );

    const close: Effect.Effect<void> = Effect.sync(() => {
        if (closed) return;
        closed = true;
        lib.symbols.duckdb_disconnect(ptr(connBuf));
        lib.symbols.duckdb_close(ptr(dbBuf));
    });

    return { path, readOnly, query, queryAs, exec, close };
};

/** Build the `DuckDbService` over an already-opened `LibDuckDb`. `fs` is
 *  closed over from the layer so `open`/`scoped` stay `R = never`. */
const makeService = (lib: LibDuckDb, fs: FileSystem.FileSystem): DuckDbService => {
    const open: DuckDbService["open"] = (path, options) => {
        const readOnly = options?.readOnly ?? false;
        return Effect.gen(function* () {
            if (readOnly) {
                // DuckDB happily creates an empty database on open when one
                // doesn't exist - fine for read-write, but for a read-only
                // open that would silently turn "the snapshot is missing"
                // into an empty result set instead of a legible error.
                const exists = yield* fs.exists(path).pipe(
                    Effect.mapError(
                        (err) =>
                            new DuckDbOpenError({
                                path,
                                readOnly,
                                message: `failed to check whether the database file exists: ${err.message}`,
                            }),
                    ),
                );
                if (!exists) {
                    return yield* new DuckDbOpenError({
                        path,
                        readOnly,
                        message: `cannot open read-only: no database file at ${path}`,
                    });
                }
            }

            const { dbBuf, connBuf } = yield* Effect.try({
                try: () => openDatabase(lib, path, readOnly),
                catch: (err) =>
                    err instanceof DuckDbOpenError
                        ? err
                        : new DuckDbOpenError({ path, readOnly, message: errorMessage(err) }),
            });

            return makeConnection(lib, path, readOnly, dbBuf, connBuf);
        });
    };

    const scoped: DuckDbService["scoped"] = (path, options) =>
        Effect.acquireRelease(open(path, options), (conn) => conn.close);

    /**
     * Copy `livePath`'s current contents to `targetPath` via DuckDB's own
     * `COPY FROM DATABASE ... TO` (which snapshots the live catalog, not
     * merely the file bytes), landing the copy at a TEMP PATH THAT IS A
     * SIBLING OF `targetPath` and only then `fs.rename`-ing it into place.
     * Same directory -> same filesystem -> the rename is atomic (never
     * `EXDEV`), which is the entire point: a reader that already has
     * `targetPath` open keeps reading the OLD inode uninterrupted for as long
     * as it holds that handle, even while this swaps in a new one.
     *
     * The writer connection doing the copy is closed BEFORE the rename
     * (inside the `Effect.ensuring` guarding the copy - or, with
     * `options.from`, simply never closed at all, see below), so the temp
     * file never has an open writer at the moment it becomes the published
     * snapshot. The whole operation is wrapped in an outer `Effect.ensuring`
     * that removes the temp file unconditionally - on success it is already
     * gone (renamed away) so the removal is a harmless no-op; on any failure
     * it deletes the half-written temp file, so `targetPath` - which nothing
     * touches until the final rename - is left exactly as it was.
     *
     * RULING R14 - READ THIS BEFORE CALLING WITHOUT `options.from`:
     * without `options.from`, this function opens its OWN, SEPARATE
     * `duckdb_open_ext` handle on `livePath`. If another handle on that same
     * path is ALREADY OPEN IN THIS PROCESS - e.g. an ingest writer, which is
     * exactly the epic's intended call site ("writes happen inside ingest
     * against the live database... publish is the hand-off at the end of
     * that ingest") - this second handle is NOT guaranteed to observe the
     * first handle's later commits. Confirmed empirically: a writer that
     * inserted rows up to a count of 5 while a bare (no-`from`)
     * `publishSnapshot` call ran concurrently produced a published snapshot
     * frozen at 3 - two committed rows silently missing, no error anywhere.
     * The `CHECKPOINT` this function issues runs on ITS OWN instance, so it
     * cannot flush a DIFFERENT open instance's state.
     *
     * The fix is `options.from`: pass the writer's own already-open
     * `DuckDbConnection` and this function runs `CHECKPOINT` / `ATTACH` /
     * `COPY FROM DATABASE` / `DETACH` on THAT connection instead of opening a
     * second one - so it always sees exactly what the writer has committed.
     * This function never closes a connection handed in via `options.from`;
     * the caller owns its lifecycle. Calling without `options.from` is only
     * safe when no writer on `livePath` is open in this process (e.g. a
     * standalone snapshot command run after ingest has fully exited) - do
     * not use it as the ingest-time publish path.
     */
    const publishSnapshot: DuckDbService["publishSnapshot"] = (livePath, targetPath, options) => {
        const tmp = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        // Cross-review P3-6: this used to be `Effect.ignore`, so a temp file
        // that could NOT be removed vanished from the record entirely - and
        // the temp file here is a COMPLETE COPY of the database, i.e. the
        // largest piece of litter this module can leave. `force: true`
        // already tolerates "already gone", so anything reaching this handler
        // is a real failure and is worth one line in the log. It still must
        // not fail the publish: this runs as an `Effect.ensuring` finalizer,
        // where masking the primary error would be worse than the leak.
        const removeTmp = fs.remove(tmp, { force: true, recursive: true }).pipe(
            Effect.catch((err) =>
                Effect.logWarning(
                    `ax duckdb: could not remove the temporary snapshot copy at ${tmp}: ${err.message}`,
                ),
            ),
        );

        const copyThrough = (conn: DuckDbConnection) => {
            // A per-call alias, not a fixed constant. Fix round 1's `from`
            // hands publishSnapshot a caller-owned, LONG-LIVED connection
            // that is reused across repeated publishes - the whole point of
            // R14. If a mid-copy failure somehow left this call's ATTACH
            // un-DETACHed despite the `Effect.ensuring` below (e.g. an
            // interruption racing the finalizer itself), a FIXED alias would
            // permanently poison every later publish on that same
            // connection with "database ax_snapshot already exists" -
            // silently, since the connection stays otherwise usable. A
            // randomized alias means the next publish simply never collides.
            const alias = `ax_snapshot_${crypto.randomUUID().replace(/-/g, "")}`;
            // A finalizer passed to `Effect.ensuring` must be
            // `Effect<X, never, R>` - it can never fail, and must never mask
            // the real error with a cleanup error. Cross-review P3-7: it used
            // to be `Effect.ignore`, which is stronger than "do not mask" -
            // it erased the event. This finalizer only ever runs on a span
            // whose `ATTACH` ALREADY SUCCEEDED, so a failing DETACH means the
            // caller's own long-lived connection is still carrying an
            // attached database (the exact leak `from` was built to avoid),
            // and the caller has nothing else to go on. Log it, do not fail.
            const detach = conn.exec(`DETACH "${alias}"`).pipe(
                Effect.catch((err) =>
                    Effect.logWarning(
                        `ax duckdb: could not DETACH the temporary snapshot database "${alias}" after publishing to ${targetPath}: ${err.message}`,
                    ),
                ),
            );

            return Effect.gen(function* () {
                yield* conn.exec("CHECKPOINT");
                const escapedTmp = tmp.replace(/'/g, "''");
                yield* conn.exec(`ATTACH '${escapedTmp}' AS "${alias}"`);
                // RULING R14 fix round 2: from here on, whatever happens -
                // success, a typed query failure, a defect, or interruption -
                // DETACH is guaranteed to run (`Effect.ensuring`), so a
                // long-lived `from` connection is never left with a
                // permanently attached database after a mid-copy failure.
                yield* Effect.gen(function* () {
                    const nameRow = (yield* conn.query("SELECT current_database() AS n")).rows[0];
                    if (nameRow === undefined) {
                        return yield* new SnapshotPublishError({
                            snapshotPath: targetPath,
                            message: "SELECT current_database() returned no rows",
                        });
                    }
                    const dbName = String(nameRow.n).replace(/"/g, '""');
                    yield* conn.exec(`COPY FROM DATABASE "${dbName}" TO "${alias}"`);
                }).pipe(Effect.ensuring(detach));
            }).pipe(
                Effect.mapError(
                    (err) =>
                        new SnapshotPublishError({
                            snapshotPath: targetPath,
                            message: `failed to copy live database to snapshot: ${err.message}`,
                        }),
                ),
            );
        };

        const attempt = Effect.gen(function* () {
            // Cross-review P1-6 + P2-4, both checked BEFORE anything is
            // created or opened, and both compared on the CANONICAL path so
            // `./x`, a relative spelling, or a symlinked directory cannot
            // fool them (see canonical-path.ts).
            const canonicalLive = yield* canonicalPath(fs, livePath);
            const canonicalTarget = yield* canonicalPath(fs, targetPath);

            // P2-4: publishing a database onto ITSELF is never what the
            // caller means. The rename would replace the live pathname with
            // the copy, leaving any writer that still holds the original open
            // on an unlinked inode - its later commits going to a file
            // nothing can ever read again.
            if (canonicalLive === canonicalTarget) {
                return yield* new SnapshotPublishError({
                    snapshotPath: targetPath,
                    message: `cannot publish a database onto itself: the live path ${livePath} and the snapshot path ${targetPath} are the same file`,
                });
            }

            // P1-6: `from` exists so the copy runs through the connection
            // that owns the live database (RULING R14). A connection open on
            // a DIFFERENT database would copy THAT one and publish it under
            // this snapshot's name - wrong data, no error, indistinguishable
            // downstream from a successful publish.
            if (options?.from) {
                const canonicalFrom = yield* canonicalPath(fs, options.from.path);
                if (canonicalFrom !== canonicalLive) {
                    return yield* new SnapshotPublishError({
                        snapshotPath: targetPath,
                        message: `options.from is open on a different database (${options.from.path}) than the live path being published (${livePath}); pass the connection that owns the live database`,
                    });
                }
            }

            const liveExists = yield* fs.exists(livePath).pipe(
                Effect.mapError(
                    (err) =>
                        new SnapshotPublishError({
                            snapshotPath: targetPath,
                            message: `failed to check whether the live database exists: ${err.message}`,
                        }),
                ),
            );
            if (!liveExists) {
                return yield* new SnapshotPublishError({
                    snapshotPath: targetPath,
                    message: `cannot publish snapshot: no live database at ${livePath}`,
                });
            }

            // A leftover temp file from a prior crashed/interrupted publish
            // must not collide with this run's ATTACH.
            yield* removeTmp;

            yield* fs.makeDirectory(posixPath.dirname(targetPath), { recursive: true }).pipe(
                Effect.mapError(
                    (err) =>
                        new SnapshotPublishError({
                            snapshotPath: targetPath,
                            message: `failed to create the snapshot directory: ${err.message}`,
                        }),
                ),
            );

            if (options?.from) {
                // Caller-owned connection - copy through it directly (RULING
                // R14) and never close it, we don't own its lifecycle.
                yield* copyThrough(options.from);
            } else {
                // Finding 6 (final fix round): `open` then `copyThrough` used
                // to be two separate `yield*`s, so an interrupt landing
                // BETWEEN them leaked the write handle on the live database
                // for the life of the process - `conn.close` was never
                // reached because `Effect.ensuring` was only attached to the
                // SECOND yield. `acquireUseRelease` (the non-scoped sibling
                // of the `Effect.acquireRelease` `scoped` already uses above)
                // makes acquire+use+release one atomic unit: acquisition is
                // uninterruptible, and release is guaranteed to run once
                // acquisition succeeds, however `use` ends - success, typed
                // failure, defect, or interruption. Close the writer BEFORE
                // the rename below, on every path.
                yield* Effect.acquireUseRelease(
                    open(livePath, { readOnly: false }),
                    (conn) => copyThrough(conn),
                    (conn) => conn.close,
                );
            }

            yield* fs.rename(tmp, targetPath).pipe(
                Effect.mapError(
                    (err) =>
                        new SnapshotPublishError({
                            snapshotPath: targetPath,
                            message: `failed to rename the temp snapshot into place: ${err.message}`,
                        }),
                ),
            );
        });

        return attempt.pipe(Effect.ensuring(removeTmp));
    };

    const openSnapshot: DuckDbService["openSnapshot"] = (path) =>
        open(path ?? snapshotPath(), { readOnly: true });

    return { open, scoped, publishSnapshot, openSnapshot, snapshotPath };
};

export class DuckDb extends Context.Service<DuckDb, DuckDbService>()("ax/DuckDb") {}

/** `dlopen` throws synchronously - on a missing file AND on a missing symbol
 *  (ruling R2) - never let that surface as an unhandled defect. Shared by
 *  both layer constructors below so a bad dylib path is a typed
 *  `DuckDbDylibError` through either one. */
const openLibOrFail = (dylibPath: string): Effect.Effect<LibDuckDb, DuckDbDylibError> =>
    Effect.try({
        try: () => openLibDuckDb(dylibPath),
        catch: (err) =>
            new DuckDbDylibError({
                message: `failed to open libduckdb at ${dylibPath}: ${errorMessage(err)}`,
            }),
    });

/**
 * The one place a `DuckDb` layer is built, over whatever effect produces the
 * `LibDuckDb`.
 *
 * Cross-review P3-2: `Layer.effect` runs its effect IN THE LAYER'S SCOPE, so
 * an `Effect.addFinalizer` here is released when the layer is - and `dlopen`
 * handles are a per-process resource this repo hands out repeatedly (a fresh
 * `AppLayer` per `run(provide(...))` call is the established shape), so
 * never calling `lib.close()` retained one dylib handle per layer for the
 * life of the process. Bun documents `close()` as the release operation.
 *
 * Closing is best-effort by design: the finalizer must not fail, and a dylib
 * that refuses to unload is not a reason to fail a program that has already
 * finished its work.
 *
 * Exported (not on the barrel) so the release is unit-testable against a fake
 * `LibDuckDb` - a real `dlopen` handle has no observable "was I closed".
 */
export const layerFromLib = (
    openLib: Effect.Effect<LibDuckDb, DuckDbDylibError, FileSystem.FileSystem>,
): Layer.Layer<DuckDb, DuckDbDylibError, FileSystem.FileSystem> =>
    Layer.effect(DuckDb)(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const lib = yield* openLib;
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    try {
                        lib.close();
                    } catch {
                        /* an unloadable dylib must not fail teardown */
                    }
                }),
            );
            return makeService(lib, fs);
        }),
    );

const baseLayer = (
    dylibPath: string,
): Layer.Layer<DuckDb, DuckDbDylibError, FileSystem.FileSystem> =>
    layerFromLib(openLibOrFail(dylibPath));

/** Layer over an explicit dylib path - the injection point for tests and for
 *  the custom static dylib from chunk w0-dylib-ci. */
export const DuckDbLayer = (dylibPath: string): Layer.Layer<DuckDb, DuckDbDylibError> =>
    baseLayer(dylibPath).pipe(Layer.provide(BunFileSystem.layer));

const baseLive: Layer.Layer<DuckDb, DuckDbDylibError, FileSystem.FileSystem> = layerFromLib(
    Effect.gen(function* () {
        const dylibPath = yield* resolveDylibPath();
        return yield* openLibOrFail(dylibPath);
    }),
);

/** Layer that resolves the dylib itself (env override / bundled asset). */
export const DuckDbLive: Layer.Layer<DuckDb, DuckDbDylibError> = baseLive.pipe(
    Layer.provide(BunFileSystem.layer),
);
