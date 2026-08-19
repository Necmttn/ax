/**
 * The `DuckDb` service: open a database, run queries/exec through it, and
 * close it. Everything downstream in the v2 architecture reads and writes
 * through this module, so its two jobs are non-negotiable: never let a native
 * failure escape untyped, and never turn a missing/corrupt database into a
 * silent empty result.
 *
 * v3 Phase 1 (#880): the engine underneath is `@duckdb/node-api` - the
 * THREADED napi client, loaded over ax's own static libduckdb by
 * `binding.ts` - replacing the synchronous `bun:ffi` symbol table that
 * blocked the JS thread for every call (ffi.ts, deleted). What this module
 * still owns is unchanged:
 *   - the open/connect/close lifecycle, including read-only opens and the
 *     guard that refuses to silently create a database when a read-only
 *     caller expected one to already exist,
 *   - translating every native failure into one of this package's tagged
 *     errors (`DuckDbOpenError` / `DuckDbQueryError` / `DuckDbUnsupportedTypeError`),
 *   - the parameter-binding dispatch, with the SAME width/NUL guards the FFI
 *     client enforced (see `encodeParams`),
 *   - the decoded-row contract (`QueryResult`): the same JS value for the
 *     same column type as the FFI client produced, pinned by client.test.ts.
 *
 * CONCURRENCY: calls on ONE connection are serialized through a promise
 * chain, preserving the FFI client's implicit one-call-in-flight semantics
 * (and staying inside DuckDB's one-thread-per-connection comfort zone).
 * Unlike the FFI client, a running statement no longer blocks the JS thread -
 * other fibers, timers and other connections keep running - and an
 * interrupted fiber CANCELS its in-flight statement via
 * `connection.interrupt()`, which the synchronous client could never do.
 *
 * RULING R6: this is a runtime module under `packages/lib/src/`, so
 * `node:fs` / `node:path` are banned (`check:no-node-fs`). The read-only
 * existence guard goes through `FileSystem.FileSystem`, acquired once in the
 * layer and closed over by every service/connection method - so every method
 * below keeps `R = never`, exactly as the interfaces declare. `node:os`
 * `homedir()` is not banned, and `snapshotPath()`'s default
 * (`~/.ax/cache/ax-snapshot.duckdb`) uses it.
 */
import { BunFileSystem } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Schema, type Scope } from "effect";
import { homedir } from "node:os";
import { posixPath } from "../shared/path.ts";
import { stageAndRename } from "../staged-rename.ts";
import { loadNodeApiOver, type DuckDbNodeApi } from "./binding.ts";
import { canonicalPath } from "./canonical-path.ts";
import { cloneFile, statSnapshot, statsEqual, walIsQuiescent } from "./clone-file.ts";
import { resolveDylibPath } from "./dylib.ts";
import {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
    SnapshotPublishError,
} from "./errors.ts";
import { coerceValue, unsupportedColumns } from "./row-decode.ts";
import { DuckDbTypeId, type DuckDbColumn, type DuckDbParam, type DuckDbRow, type DuckDbValue, type QueryResult } from "./types.ts";
import type {
    DuckDBConnection as NapiConnection,
    DuckDBInstance as NapiInstance,
    DuckDBResultReader as NapiResultReader,
    DuckDBType as NapiType,
    DuckDBValue as NapiValue,
} from "@duckdb/node-api";

export interface DuckDbConnection {
    readonly path: string;
    readonly readOnly: boolean;
    readonly query: (
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<QueryResult, DuckDbQueryError | DuckDbUnsupportedTypeError>;
    /**
     * Decode each result row through `schema`. BIGINT CONTRACT: a DuckDB
     * `BIGINT`/`UBIGINT` column decodes to a JS `bigint` (row-decode.ts keeps
     * 64-bit widths as bigint so a row's TS type never depends on the value's
     * magnitude), and the raw rows go STRAIGHT through `schema` - so a field
     * typed `Schema.Number` against a BIGINT column FAILS with a
     * `DuckDbDecodeError` (a bigint is not a number); it is never silently
     * rounded. Type such a field `Schema.BigInt` to keep full precision, or
     * `NumberFromBigIntColumn` (bigint-column.ts) to coerce to number with an
     * out-of-safe-range failure instead of a lossy convert.
     */
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
    /** `AX_DUCKDB_SNAPSHOT`, else `AX_DATA_DIR`-rooted, else
     *  `~/.ax/cache/ax-snapshot.duckdb`. Pure - same value as the module-level
     *  {@link snapshotPath} export. */
    readonly snapshotPath: () => string;
}

/**
 * `AX_DUCKDB_SNAPSHOT`, else `<AX_DATA_DIR>/ax-snapshot.duckdb`, else
 * `~/.ax/cache/ax-snapshot.duckdb` - honours `AX_DATA_DIR` exactly like
 * {@link dylibCacheDir} and the ingest lock.
 *
 * HONOURING `AX_DATA_DIR` IS LOAD-BEARING, and this function used to skip it.
 * Its own doc comment claimed to mirror an "`AX_DATA_DIR`-less default used by
 * `dylib.ts`/`lock.ts`" - but `dylibCacheDir` honours `AX_DATA_DIR`, so the
 * comment was false and this resolver was the lone outlier. The live DB IS
 * data-dir-rooted (`<dataDir>/ax-live.duckdb`, see `ingest/run.ts`), so the pair
 * came apart: point `AX_DATA_DIR` at an empty directory, run
 * `ax ingest --since=1`, and ingest built its live DB in the isolated dir and
 * then PUBLISHED it over the real `~/.ax/cache/ax-snapshot.duckdb`. Exit 0, no
 * warning, and every read surface afterwards answered "no data" instead of
 * failing - the dominant defect class of this migration, on the main write path.
 * Measured: a 636 MB isolated store replaced the real snapshot, and `ax recall`
 * went from 1014 hits to zero.
 *
 * So: whatever roots the live DB must also root the snapshot. An isolated data
 * dir now gets an isolated snapshot, which is what asking for isolation meant.
 * `AX_DUCKDB_SNAPSHOT` keeps top precedence for pinning one explicitly.
 */
export const snapshotPath = (): string => {
    const override = process.env.AX_DUCKDB_SNAPSHOT?.trim();
    if (override) return override;
    const dataDir = process.env.AX_DATA_DIR?.trim();
    return dataDir
        ? posixPath.join(dataDir, "ax-snapshot.duckdb")
        : posixPath.join(homedir(), ".ax", "cache", "ax-snapshot.duckdb");
};

/** First 200 chars of a statement, mirroring `packages/lib/src/db.ts`'s
 *  `sqlExcerpt` - every `DuckDbQueryError`/`DuckDbDecodeError` uses it so a
 *  huge statement never bloats the error. */
const SQL_EXCERPT_LEN = 200;
const sqlExcerpt = (sql: string): string =>
    sql.length > SQL_EXCERPT_LEN ? `${sql.slice(0, SQL_EXCERPT_LEN)}…` : sql;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The inclusive bounds of DuckDB's `BIGINT` / C `int64_t`, which is the only
 * integer width this client binds a `bigint` as.
 */
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/**
 * Cross-review P1-2 (kept from the FFI client, still load-bearing): an
 * out-of-int64 `bigint` parameter is refused BEFORE it reaches the native
 * layer. The napi path (`create_int64(BigInt(v))`) throws its own error on
 * overflow rather than wrapping, but "corrupt data with no signal" and "a
 * generic native message with no fix in it" are both worse than this guard:
 * the caller keeps the exact value in the message, plus the limit it broke,
 * so the fix (store it as VARCHAR/HUGEINT text) is obvious from the error
 * alone.
 */
export const bindableBigInt = (value: bigint): boolean => value >= I64_MIN && value <= I64_MAX;

const bigintRangeMessage = (idx: number, value: bigint): string =>
    `parameter ${idx} (${value}) is outside the range this client can bind: DuckDB binds integers as a signed 64-bit int64 (${I64_MIN} to ${I64_MAX}), and a wider value would silently wrap. Pass it as text (and store the column as VARCHAR or HUGEINT) instead.`;

const nulByteMessage = (idx: number): string =>
    `parameter ${idx} contains a NUL byte (U+0000): DuckDB VARCHARs cannot round-trip an embedded NUL through this client (the FFI client truncated at it; the contract is pinned so the swap to napi cannot silently widen what callers may write). Strip or escape NUL bytes upstream before binding. #790: the ax write seam (@ax/lib/duckdb/seam, writerOver) already does this for every write it issues, so reaching this message means a write path bypassed the seam - or a READ parameter carried a NUL, which the seam deliberately does not scrub.`;

/** The napi values + explicit types for one parameter list. A plain data
 *  plan, exported for direct unit-testing without a database. */
export interface BindPlan {
    readonly values: NapiValue[];
    readonly types: NapiType[];
}

/**
 * Encode `params` into napi bind values with EXPLICIT types, preserving the
 * FFI client's binding semantics exactly:
 *   - null/undefined  -> SQL NULL
 *   - boolean         -> BOOLEAN
 *   - bigint          -> BIGINT (int64; range-guarded above)
 *   - safe-int number -> BIGINT (int64) - NOT the napi default (which infers
 *                        INTEGER/DOUBLE), because the FFI client always bound
 *                        integers via `duckdb_bind_int64`
 *   - other number    -> DOUBLE
 *   - Date            -> VARCHAR of `toISOString()`
 *   - string          -> VARCHAR (NUL-guarded above)
 *
 * Explicit types matter: napi's own inference maps a JS `bigint` to HUGEINT,
 * which would silently change every integer comparison's type from the FFI
 * behavior callers were written against.
 *
 * Throws `DuckDbQueryError` - callers run it inside the same try that wraps
 * the statement itself.
 */
export const encodeParams = (
    api: DuckDbNodeApi,
    sql: string,
    params: ReadonlyArray<DuckDbParam>,
): BindPlan => {
    const values: NapiValue[] = [];
    const types: NapiType[] = [];
    for (let i = 0; i < params.length; i += 1) {
        const param = params[i];
        if (param === null || param === undefined) {
            values.push(null);
            types.push(api.SQLNULL); // create_null_value
        } else if (typeof param === "boolean") {
            values.push(param);
            types.push(api.BOOLEAN);
        } else if (typeof param === "bigint") {
            if (!bindableBigInt(param)) {
                throw new DuckDbQueryError({
                    sql: sqlExcerpt(sql),
                    message: bigintRangeMessage(i + 1, param),
                });
            }
            values.push(param);
            types.push(api.BIGINT);
        } else if (typeof param === "number") {
            if (Number.isSafeInteger(param)) {
                values.push(BigInt(param));
                types.push(api.BIGINT);
            } else {
                values.push(param);
                types.push(api.DOUBLE);
            }
        } else if (param instanceof Date) {
            values.push(param.toISOString());
            types.push(api.VARCHAR);
        } else {
            if (param.includes("\0")) {
                throw new DuckDbQueryError({
                    sql: sqlExcerpt(sql),
                    message: nulByteMessage(i + 1),
                });
            }
            values.push(param);
            types.push(api.VARCHAR);
        }
    }
    return { values, types };
};

/**
 * One decoded cell: the napi value for a SUPPORTED column type (see
 * `unsupportedColumns` / row-decode.ts for the closed set) becomes the same
 * JS value the FFI client produced for that type:
 *   - BOOLEAN -> boolean; narrow ints/floats -> number (napi hands them over
 *     as numbers already)
 *   - BIGINT/UBIGINT/HUGEINT/UHUGEINT -> bigint (64-bit stays bigint so a
 *     row's TS type never depends on a value's magnitude; int128 is
 *     arbitrary-precision in a JS bigint)
 *   - VARCHAR -> string
 *   - TIMESTAMP -> `Date`, MILLISECOND-truncated (P2-2 contract): the napi
 *     value renders to DuckDB's own text form and goes through the SAME
 *     `coerceValue` text path the FFI client used, so `.999999` still reads
 *     back `.999` and an unparseable rendering (e.g. `infinity`) still falls
 *     back to its text
 *   - DATE/TIME/INTERVAL/DECIMAL -> their DuckDB text rendering (string),
 *     exactly as `duckdb_value_varchar` produced
 *
 * Exported for direct unit-testing without a database.
 */
export const decodeCell = (typeId: number, value: NapiValue): DuckDbValue => {
    if (value === null) return null;
    switch (typeof value) {
        case "boolean":
            return value;
        case "number":
            return value;
        case "string":
            return coerceValue(typeId, value);
        case "bigint":
            // 64-bit and 128-bit integer columns keep bigint; anything else
            // napi chose to hand over as bigint is width-safe to narrow.
            return typeId === DuckDbTypeId.BIGINT ||
                    typeId === DuckDbTypeId.UBIGINT ||
                    typeId === DuckDbTypeId.HUGEINT ||
                    typeId === DuckDbTypeId.UHUGEINT
                ? value
                : Number(value);
        default:
            // A value object (timestamp/date/time/interval/decimal): its
            // toString() is DuckDB's own text rendering - the same text the
            // row-major varchar accessor produced - so the coerce rules apply
            // unchanged.
            return coerceValue(typeId, String(value));
    }
};

/**
 * Decode a finished reader into `QueryResult`. Refuses (typed) BEFORE reading
 * any cell:
 *   - duplicate column names (cross-review P2-1, half one: rows are keyed by
 *     name, so two columns sharing one would silently overwrite each other),
 *   - any column outside the supported closed set (`DuckDbUnsupportedTypeError`
 *     via `unsupportedColumns` - a BLOB/TIMESTAMP_TZ/UUID/... column must
 *     never let a differently-shaped value through just because the napi
 *     driver CAN render it; every caller was written against the closed set).
 */
const decodeReader = (reader: NapiResultReader, sql: string): QueryResult => {
    const names = reader.columnNames();
    const columns: DuckDbColumn[] = names.map((name, i) => ({
        name,
        typeId: reader.columnTypeId(i) as number,
    }));

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

    const rawRows = reader.getRows();
    const rows: DuckDbRow[] = [];
    for (const rawRow of rawRows) {
        // Cross-review P2-1, half two: on a normal `{}` the assignment
        // `row["__proto__"] = v` hits Object.prototype's `__proto__` SETTER,
        // which ignores a non-object value - so a `__proto__` column silently
        // vanished from every row. A null-prototype object has no inherited
        // accessors at all, so every column name (`__proto__`, `constructor`,
        // `toString`) round-trips as plain data.
        const row: Record<string, DuckDbValue> = Object.create(null) as Record<string, DuckDbValue>;
        for (let c = 0; c < columns.length; c += 1) {
            row[columns[c]!.name] = decodeCell(columns[c]!.typeId, rawRow[c] ?? null);
        }
        rows.push(row);
    }

    return { columns, rows, rowsChanged: reader.rowsChanged };
};

/** Build the `DuckDbConnection` for one open database handle. */
const makeConnection = (
    api: DuckDbNodeApi,
    path: string,
    readOnly: boolean,
    instance: NapiInstance,
    connection: NapiConnection,
): DuckDbConnection => {
    let closed = false;

    /**
     * The per-connection serialization chain: exactly one statement in flight
     * per connection, in submission order - the FFI client's semantics, kept
     * on purpose (callers interleave DDL/DML on one writer connection and
     * were never written against concurrent execution). The chain never
     * rejects (each link's outcome is absorbed), so one failed statement
     * cannot poison the queue.
     */
    let tail: Promise<unknown> = Promise.resolve();

    /**
     * Cross-review P1-1, napi edition: `close` tears down the native
     * connection/instance, so a statement issued after it must never reach
     * them. The FFI version re-checked a flag before touching a raw pointer;
     * here the check runs BOTH at effect-run time (`Effect.suspend`) and
     * again when the statement's turn in the chain arrives - a query built
     * before `close` and already queued when `close` lands is refused, not
     * run against a disconnecting handle.
     */
    const closedError = (sql: string): DuckDbQueryError =>
        new DuckDbQueryError({
            sql: sqlExcerpt(sql),
            message: `the connection to ${path} is closed; open a new one (a statement on a closed connection would touch a torn-down native handle)`,
        });

    const closedInterrupt = (sql: string): DuckDbQueryError =>
        new DuckDbQueryError({
            sql: sqlExcerpt(sql),
            message: "statement was interrupted before it started",
        });

    const runQuery = (
        sql: string,
        params: ReadonlyArray<DuckDbParam>,
        signal: AbortSignal,
    ): Promise<QueryResult> => {
        const run = async (): Promise<QueryResult> => {
            if (closed) throw closedError(sql);
            if (signal.aborted) throw closedInterrupt(sql);
            // Interruption: while THIS statement is the one running, an abort
            // cancels it natively. Registered only after the chain reaches us,
            // so aborting a still-queued statement can never interrupt a
            // DIFFERENT caller's in-flight work.
            const onAbort = (): void => {
                try {
                    connection.interrupt();
                } catch {
                    /* best-effort: an uninterruptible statement finishes on its own */
                }
            };
            signal.addEventListener("abort", onAbort, { once: true });
            try {
                const plan = encodeParams(api, sql, params);
                const reader =
                    plan.values.length === 0
                        ? await connection.runAndReadAll(sql)
                        : await connection.runAndReadAll(sql, plan.values, plan.types);
                return decodeReader(reader, sql);
            } finally {
                signal.removeEventListener("abort", onAbort);
            }
        };
        const turn = tail.then(run, run);
        tail = turn.then(
            () => undefined,
            () => undefined,
        );
        return turn;
    };

    const query: DuckDbConnection["query"] = (sql, params = []) =>
        Effect.suspend(() =>
            closed
                ? Effect.fail(closedError(sql))
                : Effect.tryPromise({
                      try: (signal) => runQuery(sql, params, signal),
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

    /**
     * Close AFTER the chain drains: `closed` flips first (new statements are
     * refused immediately, queued ones refuse at their turn), then the
     * disconnect runs once nothing native is in flight - `disconnectSync`
     * during a running statement is the napi equivalent of the dangling-
     * pointer segfault the FFI client's flag existed to prevent. Idempotent:
     * the teardown chains once; later calls await the same drained chain.
     */
    const close: Effect.Effect<void> = Effect.suspend(() => {
        if (!closed) {
            closed = true;
            tail = tail.then(
                () => teardown(),
                () => teardown(),
            );
        }
        const settled = tail.then(
            () => undefined,
            () => undefined,
        );
        return Effect.promise(() => settled);
    });

    const teardown = (): void => {
        try {
            connection.disconnectSync();
        } catch {
            /* already torn down */
        }
        try {
            instance.closeSync();
        } catch {
            /* already torn down */
        }
    };

    return { path, readOnly, query, queryAs, exec, close };
};

/** Build the `DuckDbService` over a loaded `@duckdb/node-api`. `fs` is
 *  closed over from the layer so `open`/`scoped` stay `R = never`. */
const makeService = (api: DuckDbNodeApi, fs: FileSystem.FileSystem): DuckDbService => {
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

            const opened = yield* Effect.tryPromise({
                try: async () => {
                    // Same config key the FFI client set through duckdb_config:
                    // access_mode READ_ONLY refuses writes at the engine.
                    const instance = await api.DuckDBInstance.create(
                        path,
                        readOnly ? { access_mode: "READ_ONLY" } : {},
                    );
                    try {
                        const connection = await instance.connect();
                        return { instance, connection };
                    } catch (err) {
                        try {
                            instance.closeSync();
                        } catch {
                            /* connect failed; instance close is best-effort */
                        }
                        throw err;
                    }
                },
                catch: (err) =>
                    new DuckDbOpenError({ path, readOnly, message: errorMessage(err) }),
            });

            return makeConnection(api, path, readOnly, opened.instance, opened.connection);
        });
    };

    const scoped: DuckDbService["scoped"] = (path, options) =>
        Effect.acquireRelease(open(path, options), (conn) => conn.close);

    /**
     * Copy `livePath`'s current contents to `targetPath`, landing the copy
     * at a TEMP PATH THAT IS A SIBLING OF `targetPath` and only then
     * `fs.rename`-ing it into place. Same directory -> same filesystem ->
     * the rename is atomic (never `EXDEV`), which is the entire point: a
     * reader that already has `targetPath` open keeps reading the OLD inode
     * uninterrupted for as long as it holds that handle, even while this
     * swaps in a new one.
     *
     * TWO ways to produce that temp file, tried in this order (#908):
     *
     *  1. THE CLONE FAST PATH (`attemptClone` below): after a `CHECKPOINT`,
     *     clone `livePath` onto the temp path via APFS `clonefile`
     *     (copy-on-write - near-instant regardless of catalog size,
     *     `clone-file.ts`). Taken ONLY when every guard in `attemptClone`
     *     holds; any failure - the env escape hatch, a checkpoint failure, a
     *     non-empty post-checkpoint WAL, a stat mismatch across the clone
     *     (torn-copy tripwire), a failed clonefile syscall (non-APFS,
     *     `EXDEV`, `ENOTSUP`, ...), or a failed sanity-open of the staged
     *     clone - falls back to path 2 silently (logged at debug), never
     *     surfacing as a `publishSnapshot` failure by itself.
     *  2. THE LOGICAL PATH (`copyThrough`, unchanged): DuckDB's own
     *     `CHECKPOINT` / `ATTACH` / `COPY FROM DATABASE ... TO` / `DETACH`,
     *     which snapshots the live catalog logically rather than cloning
     *     file bytes - slower (a full logical copy of the whole catalog) but
     *     has no filesystem-support requirement, so it is the correctness
     *     baseline every clone attempt falls back to.
     *
     * Both land the SAME temp path inside ONE `stageAndRename` call, so
     * there is still exactly one atomic rename per publish regardless of
     * which path produced the file.
     *
     * The writer connection doing the (logical) copy is closed BEFORE the
     * rename (inside the `Effect.ensuring` guarding the copy - or, with
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
     * database handle on `livePath`. If another handle on that same
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
        // The temp-path naming, the pre-stage clear, the atomic rename, and the
        // remove-the-temp-on-every-exit-path finalizer (including cross-review
        // P3-6's "log, do not ignore" - the litter here is a COMPLETE COPY of
        // the database) all live in `stageAndRename` (`@ax/lib/staged-rename`),
        // shared with the config writer and the dylib extractor. What stays
        // here is what only a database publish needs: the same-file and
        // wrong-`from` guards, and the CHECKPOINT/ATTACH/COPY/DETACH itself.
        const copyThrough = (conn: DuckDbConnection, tmp: string) => {
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

        /** `AX_SNAPSHOT_CLONE=off` forces the logical path unconditionally -
         *  read fresh on every call (not memoized), so a test or a runtime
         *  toggle takes effect on the very next publish. */
        const cloneDisabledByEnv = (): boolean =>
            (process.env.AX_SNAPSHOT_CLONE ?? "").trim().toLowerCase() === "off";

        /** Best-effort: only ever called on a path where `cloneFile` already
         *  wrote something to `tmp` and a LATER guard rejected it, so the
         *  fallback about to run (`copyThrough` on the SAME `tmp`) doesn't
         *  `ATTACH` onto a stale, half-trusted clone. Never fails - a removal
         *  failure here just surfaces naturally as the fallback's own ATTACH
         *  error against a non-empty path, which is a legible failure either
         *  way. This is NOT the tmp-cleanup `stageAndRename`'s finalizer
         *  already owns (that still runs unconditionally on every exit); it
         *  exists only so the same `tmp` path can be reused a second time
         *  within THIS one `stage` call. */
        const clearPartialClone = (tmp: string): Effect.Effect<void> =>
            fs.remove(tmp, { force: true, recursive: true }).pipe(
                Effect.catch((err) =>
                    Effect.logWarning(
                        `ax duckdb: could not clear the partially-cloned temp file at ${tmp} before falling back to the logical copy: ${err.message}`,
                    ),
                ),
            );

        /**
         * The #908 clone fast path. Never fails: every guard below reports a
         * rejection as `{ mode: "copy", reason }` instead of an error, so the
         * caller can fall back to `copyThrough` on the exact same `tmp`
         * within the SAME `stageAndRename` call - one atomic rename either
         * way. Only ever returns `{ mode: "clone" }` once the staged file at
         * `tmp` has been checkpoint-consistent, byte-cloned without a torn
         * read, and has itself opened read-only and answered a sanity query.
         *
         * Safety protocol (all four must hold):
         *  (a) `CHECKPOINT` succeeds on the connection that actually owns the
         *      live database - the writer's own `options.from` when given
         *      (RULING R14: a second handle on `livePath` cannot be trusted
         *      to see that writer's commits), else a dedicated open -> checkpoint
         *      -> CLOSE (closing the writer before cloning is trivially safe -
         *      nothing has `livePath` open in this process afterward).
         *  (b) `<livePath>.wal` is absent or 0 bytes immediately after the
         *      checkpoint - a non-empty WAL means the checkpoint left
         *      committed data outside the base file the clone is about to
         *      copy.
         *  (c) `stat(livePath)` taken immediately before and immediately
         *      after the clone syscall reports the identical size + mtime -
         *      the torn-copy tripwire: something else wrote to `livePath`
         *      while the clone ran, so its contents can no longer be trusted.
         *  (d) the staged clone at `tmp` opens read-only and answers
         *      `SELECT count(*) AS n FROM duckdb_tables()` with a positive
         *      count, closed again before this returns.
         */
        const attemptClone = (
            tmp: string,
        ): Effect.Effect<{ readonly mode: "clone" } | { readonly mode: "copy"; readonly reason: string }> =>
            Effect.gen(function* () {
                if (cloneDisabledByEnv()) {
                    return { mode: "copy", reason: "AX_SNAPSHOT_CLONE=off" } as const;
                }

                // (a) CHECKPOINT on the connection that owns the live database.
                const checkpoint = yield* Effect.result(
                    options?.from
                        ? options.from.exec("CHECKPOINT").pipe(Effect.asVoid)
                        : Effect.acquireUseRelease(
                              open(livePath, { readOnly: false }),
                              (conn) => conn.exec("CHECKPOINT").pipe(Effect.asVoid),
                              (conn) => conn.close,
                          ),
                );
                if (checkpoint._tag === "Failure") {
                    return {
                        mode: "copy",
                        reason: `checkpoint before clone failed: ${checkpoint.failure.message}`,
                    } as const;
                }

                // (b) post-checkpoint WAL tripwire.
                const walQuiescent = yield* walIsQuiescent(fs, livePath);
                if (!walQuiescent) {
                    return { mode: "copy", reason: "WAL is non-empty after checkpoint" } as const;
                }

                // (c) torn-copy tripwire, half one: stat before the clone.
                const before = yield* Effect.result(statSnapshot(fs, livePath));
                if (before._tag === "Failure") {
                    return {
                        mode: "copy",
                        reason: `pre-clone stat of the live database failed: ${before.failure.message}`,
                    } as const;
                }

                const clone = yield* cloneFile(livePath, tmp);
                if (!clone.cloneable) {
                    return { mode: "copy", reason: clone.reason ?? "clonefile syscall failed" } as const;
                }

                // (c) torn-copy tripwire, half two: stat after the clone.
                const after = yield* Effect.result(statSnapshot(fs, livePath));
                if (after._tag === "Failure") {
                    yield* clearPartialClone(tmp);
                    return {
                        mode: "copy",
                        reason: `post-clone stat of the live database failed: ${after.failure.message}`,
                    } as const;
                }
                if (!statsEqual(before.success, after.success)) {
                    yield* clearPartialClone(tmp);
                    return {
                        mode: "copy",
                        reason: "torn-copy tripwire: the live database's size/mtime changed during the clone",
                    } as const;
                }

                // (d) the staged clone must open read-only and answer a
                // sanity query before it is trusted as the publish.
                const verified = yield* Effect.result(
                    Effect.acquireUseRelease(
                        open(tmp, { readOnly: true }),
                        (conn) =>
                            conn.query("SELECT count(*) AS n FROM duckdb_tables()").pipe(
                                Effect.map((result) => {
                                    const n = result.rows[0]?.n;
                                    return typeof n === "bigint" && n > 0n;
                                }),
                            ),
                        (conn) => conn.close,
                    ),
                );
                if (verified._tag === "Failure") {
                    yield* clearPartialClone(tmp);
                    return {
                        mode: "copy",
                        reason: `sanity check on the staged clone failed: ${verified.failure.message}`,
                    } as const;
                }
                if (!verified.success) {
                    yield* clearPartialClone(tmp);
                    return {
                        mode: "copy",
                        reason: "sanity check on the staged clone found no tables",
                    } as const;
                }

                return { mode: "clone" } as const;
            });

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

            const liveExists: boolean = yield* fs.exists(livePath).pipe(
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

            // Finding 6 (final fix round, pre-#908): `open` then `copyThrough`
            // used to be two separate `yield*`s, so an interrupt landing
            // BETWEEN them leaked the write handle on the live database for
            // the life of the process - `conn.close` was never reached
            // because `Effect.ensuring` was only attached to the SECOND
            // yield. `acquireUseRelease` makes acquire+use+release one atomic
            // unit: acquisition is uninterruptible, and release is guaranteed
            // to run once acquisition succeeds, however `use` ends - success,
            // typed failure, defect, or interruption. This closes the writer
            // BEFORE the rename, on every path, because the whole `stage`
            // step completes before `stageAndRename` renames.
            const logicalCopy = (tmp: string) =>
                options?.from
                    ? // Caller-owned connection - copy through it directly
                      // (RULING R14) and never close it, we don't own its
                      // lifecycle.
                      copyThrough(options.from, tmp)
                    : Effect.acquireUseRelease(
                          open(livePath, { readOnly: false }),
                          (conn) => copyThrough(conn, tmp),
                          (conn) => conn.close,
                      );

            yield* stageAndRename<SnapshotPublishError | DuckDbOpenError>(targetPath, {
                // #908: try the clone fast path first; `attemptClone` never
                // fails, so a rejection just falls through to the SAME
                // logical path this stage function ran unconditionally
                // before - one `stageAndRename` call, one atomic rename,
                // either way.
                stage: (tmp) =>
                    Effect.gen(function* () {
                        const cloned = yield* attemptClone(tmp);
                        if (cloned.mode === "clone") {
                            yield* Effect.logDebug(
                                `ax duckdb: publishSnapshot(${targetPath}) took the clone fast path (APFS clonefile)`,
                            );
                            return;
                        }
                        yield* Effect.logDebug(
                            `ax duckdb: publishSnapshot(${targetPath}) took the logical copy path: ${cloned.reason}`,
                        );
                        yield* logicalCopy(tmp);
                    }),
                onFsError: (step, err) =>
                    new SnapshotPublishError({
                        snapshotPath: targetPath,
                        message:
                            step === "rename"
                                ? `failed to rename the temp snapshot into place: ${err.message}`
                                : `failed to prepare the snapshot destination (${step}): ${err.message}`,
                    }),
                // `fs` is closed over from the layer (RULING R6), so the shared
                // primitive's `FileSystem` requirement is satisfied HERE and
                // `DuckDbService`'s signatures keep `R = never`.
            }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        });

        return attempt;
    };

    const openSnapshot: DuckDbService["openSnapshot"] = (path) =>
        open(path ?? snapshotPath(), { readOnly: true });

    return { open, scoped, publishSnapshot, openSnapshot, snapshotPath };
};

export class DuckDb extends Context.Service<DuckDb, DuckDbService>()("ax/DuckDb") {}

/**
 * The service plus the release hook the FFI client's `dlopen` handle needed.
 * A napi addon CANNOT be unloaded (the native module registers process-wide),
 * so `close` is now a documented no-op - kept so every existing teardown path
 * (the seam's layer finalizer, tests) stays shaped exactly as before.
 */
export interface OpenedDuckDb {
    readonly db: DuckDbService;
    /** No-op under the napi driver (a native addon outlives every scope);
     *  never throws, exactly as teardown paths require. */
    readonly close: () => void;
}

/** Options for the layer constructors and {@link openDuckDbService}. */
export interface DuckDbLiveOptions {
    /** The bundled libduckdb asset path (an apps-side `{ type: "file" }` embed
     *  import). `packages/lib` cannot import from `apps/*`, so the embed lives
     *  on the consumer's side and is threaded in here rather than imported
     *  directly - see `apps/axctl/src/duckdb-embed.gen.ts`'s header (#791,
     *  wave 3 c-binary-embed). `null` and `undefined` both mean "no bundled
     *  asset". */
    readonly assetPath?: string | null;
    /** The bundled `duckdb.node` addon asset path, same threading story as
     *  `assetPath` (#880: the napi driver needs the addon bytes too in a
     *  compiled binary). Unset in source mode - the addon resolves from
     *  node_modules. */
    readonly nodeBindingAssetPath?: string | null;
}

/** Resolve the dylib, load the napi driver over it, build the service. */
const serviceOver = (
    fs: FileSystem.FileSystem,
    options?: DuckDbLiveOptions,
): Effect.Effect<DuckDbService, DuckDbDylibError> =>
    Effect.gen(function* () {
        const assetPath = options?.assetPath ?? undefined;
        const dylibPath = yield* resolveDylibPath(assetPath === undefined ? {} : { assetPath }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
        );
        const api = yield* loadNodeApiOver(fs, {
            dylibPath,
            nodeBindingPath: options?.nodeBindingAssetPath ?? undefined,
        });
        return makeService(api, fs);
    });

/**
 * Open the driver and build the service over it, WITHOUT a `Scope`.
 *
 * Every other constructor here is a `Layer`, which is right for a program that
 * knows at startup that it needs a database. The read seam does not: it must be
 * safe to put in a long-lived layer (`ax studio`, `ax mcp`) on a machine with no
 * dylib and no cache yet, and only pay for - and only fail on - the first query
 * that actually arrives. A layer cannot express that, because `Layer.effect`
 * runs eagerly at provide time. So the seam holds THIS, calls it lazily, and
 * calls `close` from its own layer finalizer.
 *
 * `fs` is passed in rather than required, so the result has `R = never` and can
 * be called from inside a service method.
 */
export const openDuckDbService = (
    fs: FileSystem.FileSystem,
    options?: DuckDbLiveOptions,
): Effect.Effect<OpenedDuckDb, DuckDbDylibError> =>
    Effect.map(serviceOver(fs, options), (db) => ({ db, close: () => {} }));

/** {@link openDuckDbService} with the dylib path already decided. */
export const openDuckDbServiceAt = (
    fs: FileSystem.FileSystem,
    dylibPath: string,
): Effect.Effect<OpenedDuckDb, DuckDbDylibError> =>
    Effect.map(
        Effect.flatMap(loadNodeApiOver(fs, { dylibPath }), (api) =>
            Effect.succeed(makeService(api, fs)),
        ),
        (db) => ({ db, close: () => {} }),
    );

const layerOver = (
    options?: DuckDbLiveOptions,
): Layer.Layer<DuckDb, DuckDbDylibError, FileSystem.FileSystem> =>
    Layer.effect(DuckDb)(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* serviceOver(fs, options);
        }),
    );

/** Layer over an explicit dylib path - the injection point for tests and for
 *  the custom static dylib from chunk w0-dylib-ci. */
export const DuckDbLayer = (dylibPath: string): Layer.Layer<DuckDb, DuckDbDylibError> =>
    Layer.effect(DuckDb)(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const api = yield* loadNodeApiOver(fs, { dylibPath });
            return makeService(api, fs);
        }),
    ).pipe(Layer.provide(BunFileSystem.layer));

/** Layer that resolves the dylib itself (env override / bundled asset).
 *  `options.assetPath` threads through to {@link resolveDylibPath} as its
 *  fallback source once `AX_DUCKDB_DYLIB` is unset - see {@link DuckDbLiveOptions}. */
export const DuckDbLiveWith = (options?: DuckDbLiveOptions): Layer.Layer<DuckDb, DuckDbDylibError> =>
    layerOver(options).pipe(Layer.provide(BunFileSystem.layer));

/** `DuckDbLiveWith()` with no bundled asset - env override only. */
export const DuckDbLive: Layer.Layer<DuckDb, DuckDbDylibError> = DuckDbLiveWith();
