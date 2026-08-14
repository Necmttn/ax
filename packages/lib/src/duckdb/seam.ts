/**
 * THE SEAM. Every v2 reader and every v2 writer goes through this module, and
 * the two halves are deliberately not symmetrical:
 *
 *   READS  ({@link CacheRead})  open the PUBLISHED SNAPSHOT, read-only. They
 *          never touch the live database, so an ingest writing at full speed
 *          cannot slow a query down, and a reader holding the old snapshot keeps
 *          reading it uninterrupted across a publish.
 *   WRITES ({@link withCacheWrite}) open the live database read-write, and ONLY
 *          inside ingest, under the ingest lock. Not by convention: the write
 *          constructor asks `@ax/lib/ingest-lock` whether this process holds the
 *          lock and REFUSES with a typed error if it does not. There is no other
 *          exported way to obtain a `CacheWriteService`, so "writes only happen
 *          inside ingest, under the lock" is a property of the type system plus
 *          one runtime check, rather than a rule someone has to remember.
 *
 * WHAT THE SEAM OWNS THAT THE DDL CANNOT SAY. Three things the schema file is
 * structurally unable to express, so they live here or nowhere:
 *
 *  1. THE UTC CLOCK CHECK on every write connection (`assertUtcClock`). The DDL
 *     declares every TIMESTAMP column to be UTC, and both its
 *     `DEFAULT CURRENT_TIMESTAMP` columns and the stamped columns below take
 *     their value from the DATABASE's clock. If that clock were not UTC they
 *     would silently record local time. Note this is a CHECK, not a `SET`: see
 *     `assertUtcClock` for the measurement showing why `SET TimeZone='UTC'` is
 *     both unnecessary and actively broken against the dylib ax ships.
 *  2. {@link WRITE_STAMPED_COLUMNS}. Surreal's `VALUE time::now()` OVERWROTE the
 *     caller's value on every create AND every update. A DuckDB `DEFAULT` only
 *     fires when an INSERT omits the column, and does nothing at all on UPDATE,
 *     so three columns lost their semantics in translation (schema.duckdb.sql's
 *     SEMANTICS block names them). `put`/`putMany` stamp them unconditionally.
 *  3. Identifier quoting and validation. `commit` is a SQL keyword, and a table
 *     or column name is the one part of a statement that cannot be a bound
 *     parameter. Every identifier this seam emits is checked against a strict
 *     pattern and quoted; anything else is a typed refusal, never interpolated.
 *
 * WHY READS ARE LAZY AND MEMOIZED ON SUCCESS ONLY. `CacheReadLayer` must be safe
 * to sit in a long-lived layer on a machine that has no dylib and no snapshot
 * yet - `ax serve` and `ax mcp` build their layers at startup, long before anyone
 * runs a query - so NOTHING is opened at layer-build time. The first query opens
 * the dylib and the snapshot and remembers them. A FAILURE is deliberately not
 * remembered: the common shape is a daemon that started before the first ingest,
 * and it must pick the snapshot up once it appears rather than reporting "no
 * cache" for the rest of its life.
 *
 * RULING R6: runtime module under `packages/lib/src/` - `node:fs` / `node:path`
 * are banned; filesystem access goes through `FileSystem.FileSystem`.
 */
import { BunFileSystem } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";
import { ingestLockHeldHere } from "../ingest-lock.ts";
import {
    openDuckDbService,
    snapshotPath as defaultSnapshotPath,
    type DuckDbConnection,
    type DuckDbLiveOptions,
} from "./client.ts";
import {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
    SnapshotPublishError,
} from "./errors.ts";
import type { DuckDbParam, QueryResult } from "./types.ts";

/**
 * The cache could not be opened at all: no snapshot published yet, no libduckdb,
 * or a database that will not open. Distinct from a query failure ON PURPOSE -
 * "you have not ingested yet" is the single most common thing a new user hits,
 * and it deserves an answer that names the fix rather than a raw open error.
 */
export class CacheUnavailableError extends Schema.TaggedErrorClass<CacheUnavailableError>(
    "CacheUnavailableError",
)("CacheUnavailableError", {
    path: Schema.String,
    message: Schema.String,
}) {}

/** Someone tried to open the cache for WRITING without holding the ingest lock. */
export class CacheWriteUnlockedError extends Schema.TaggedErrorClass<CacheWriteUnlockedError>(
    "CacheWriteUnlockedError",
)("CacheWriteUnlockedError", {
    livePath: Schema.String,
    lockPath: Schema.String,
    message: Schema.String,
}) {}

export type CacheReadError =
    | CacheUnavailableError
    | DuckDbQueryError
    | DuckDbUnsupportedTypeError
    | DuckDbDecodeError;

export type CacheWriteError = CacheReadError | CacheWriteUnlockedError | SnapshotPublishError;

export interface CacheReadService {
    /** Every row, decoded through `schema`. Use the named column codecs in
     *  `./columns.ts` so the decode contract is explicit at the call site. */
    readonly rows: <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<ReadonlyArray<S["Type"]>, CacheReadError, S["DecodingServices"]>;
    /** The first row, or `none`. A second row is NOT an error - callers that
     *  want one row write `LIMIT 1`; this is about absence, not cardinality. */
    readonly first: <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<Option.Option<S["Type"]>, CacheReadError, S["DecodingServices"]>;
    /** Undecoded result, for shapes no schema fits - `PRAGMA` output, a
     *  `current_setting` probe, an aggregate whose columns are built at runtime. */
    readonly raw: (
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<QueryResult, CacheReadError>;
    /** The snapshot this reader reads (resolved, not the caller's spelling). */
    readonly snapshotPath: string;
}

export class CacheRead extends Context.Service<CacheRead, CacheReadService>()("ax/CacheRead") {}

export interface CacheWriteService extends CacheReadService {
    readonly exec: (
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) => Effect.Effect<number, CacheWriteError>;
    /** INSERT OR REPLACE one row, stamping {@link WRITE_STAMPED_COLUMNS}. */
    readonly put: (
        table: string,
        row: Readonly<Record<string, DuckDbParam>>,
    ) => Effect.Effect<void, CacheWriteError>;
    /** {@link put} for many rows of the SAME SHAPE, batched into multi-row
     *  INSERTs. Rows with differing column sets are a typed refusal, not a
     *  silently-ragged insert. */
    readonly putMany: (
        table: string,
        rows: ReadonlyArray<Readonly<Record<string, DuckDbParam>>>,
    ) => Effect.Effect<void, CacheWriteError>;
    /** The live database being written (not the snapshot). */
    readonly livePath: string;
}

/**
 * Columns whose value the WRITER must stamp on every write, because the DDL
 * cannot. In schema.surql these were `VALUE time::now()`, which OVERWRITES what
 * the caller supplies on every create and every update alike; a DuckDB `DEFAULT`
 * only fires on an insert that omits the column, and never on an update. See the
 * SEMANTICS block in schema.duckdb.sql.
 *
 * `put` therefore IGNORES any value a caller passes for these columns and emits
 * `CURRENT_TIMESTAMP` instead - the database's own clock, matching what the DDL
 * default would have produced, and correct because every seam connection is
 * pinned to UTC.
 */
export const WRITE_STAMPED_COLUMNS: Readonly<Record<string, string>> = {
    skill: "ingested_at",
    skill_revision: "ts",
    agent_def: "ingested_at",
};

/** The identifier shape this seam will emit. Anything else is refused rather
 *  than quoted-and-hoped: a table or column name cannot be a bound parameter, so
 *  this is the only place an injection could enter a seam-built statement. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteIdentifier = (
    kind: "table" | "column",
    name: string,
): Effect.Effect<string, DuckDbQueryError> =>
    IDENTIFIER.test(name)
        ? Effect.succeed(`"${name}"`)
        : Effect.fail(
              new DuckDbQueryError({
                  sql: "",
                  message: `refusing to build a statement with the ${kind} name ${JSON.stringify(
                      name,
                  )}: a ${kind} name cannot be a bound parameter, so this seam only emits names matching ${IDENTIFIER}`,
              }),
          );

/** How many rows one `putMany` statement carries. Large enough that the
 *  per-statement overhead disappears, small enough that the SQL text and the
 *  bound-parameter count stay bounded on a wide table. */
const PUT_BATCH_ROWS = 500;

const toUnavailable = (path: string) => (err: DuckDbOpenError | DuckDbDylibError): CacheUnavailableError => {
    if (err._tag === "DuckDbDylibError") {
        return new CacheUnavailableError({
            path,
            message: `the DuckDB library could not be loaded: ${err.message}`,
        });
    }
    // The client's own "read-only open of a file that does not exist" message is
    // accurate but tells a user nothing about what to DO, and this is the single
    // most common first-run state.
    const missing = err.message.includes("no database file at");
    return new CacheUnavailableError({
        path,
        message: missing
            ? `no ax cache at ${path} yet - run \`ax ingest\` to build it`
            : `could not open the ax cache at ${path}: ${err.message}`,
    });
};

/**
 * How far the database's stored clock may sit from this process's UTC clock
 * before the write path refuses.
 *
 * Five minutes: every real time-zone offset is at least 15 minutes, so any
 * offset at all trips this, while ordinary clock skew between a process and the
 * database it just opened (both on this machine) never comes close.
 */
export const UTC_CLOCK_TOLERANCE_MS = 5 * 60_000;

/** Pure half of the UTC clock check, so its boundaries are testable without a
 *  database. `dbNow` is `CURRENT_TIMESTAMP` as DuckDB would STORE it in a naive
 *  TIMESTAMP column; `jsNow` is this process's UTC instant. */
export const utcClockOk = (dbNow: Date, jsNow: Date): boolean =>
    Math.abs(dbNow.getTime() - jsNow.getTime()) <= UTC_CLOCK_TOLERANCE_MS;

/**
 * Prove the database's own clock lands in UTC before writing anything with it.
 *
 * The DDL declares every TIMESTAMP column to be UTC, and both its
 * `DEFAULT CURRENT_TIMESTAMP` columns and {@link WRITE_STAMPED_COLUMNS} take
 * their value from the DATABASE's clock, not this process's. DuckDB's
 * `CURRENT_TIMESTAMP` is a TIMESTAMPTZ, and storing it into a naive TIMESTAMP
 * column converts it using the session's `TimeZone` - so if that were ever not
 * UTC, every one of those columns would silently record local time and nothing
 * downstream could tell.
 *
 * The obvious guard - `SET TimeZone='UTC'` on every connection - is WRONG here,
 * and measurably so: `TimeZone` is a setting the `icu` extension registers, and
 * the dylib ax ships is built with only `json` + `fts`, so the statement fails
 * outright with "Setting with name TimeZone is not in the catalog". Without icu
 * DuckDB has no time-zone database at all and renders TIMESTAMPTZ in UTC
 * unconditionally: verified against the shipped build by storing
 * `CURRENT_TIMESTAMP` under `TZ=Pacific/Kiritimati` (UTC+14) and under `TZ=UTC`
 * and getting the same instant, matching the host's UTC clock.
 *
 * So the guarantee comes from how the dylib is BUILT, which is exactly the kind
 * of guarantee that should be checked rather than assumed: a future build that
 * links icu (for `AT TIME ZONE` support, say) on a machine whose TZ is not UTC
 * would silently reintroduce the bug. This asserts the PROPERTY - "what the
 * database stores as now() is UTC now" - instead of trusting the mechanism.
 */
const assertUtcClock = (
    conn: DuckDbConnection,
    path: string,
): Effect.Effect<void, CacheUnavailableError> =>
    Effect.gen(function* () {
        const probed = yield* conn.query("SELECT CAST(CURRENT_TIMESTAMP AS TIMESTAMP) AS db_now").pipe(
            Effect.mapError(
                (err) =>
                    new CacheUnavailableError({
                        path,
                        message: `could not read the database clock: ${err.message}`,
                    }),
            ),
        );
        const dbNow = probed.rows[0]?.db_now;
        if (!(dbNow instanceof Date)) {
            return yield* new CacheUnavailableError({
                path,
                message: `the database clock probe returned ${String(dbNow)} instead of a timestamp`,
            });
        }
        const jsNow = new Date();
        if (!utcClockOk(dbNow, jsNow)) {
            return yield* new CacheUnavailableError({
                path,
                message:
                    `refusing to write: the database stores CURRENT_TIMESTAMP as ${dbNow.toISOString()} while this ` +
                    `process's UTC clock reads ${jsNow.toISOString()} - a gap of ` +
                    `${Math.round((dbNow.getTime() - jsNow.getTime()) / 60_000)} minutes. Every TIMESTAMP column in ` +
                    "this schema is declared UTC, so writing now would silently store local time. This almost " +
                    "certainly means the libduckdb build links the icu extension and its TimeZone setting is not " +
                    "UTC; ax's own build (scripts/build-duckdb.sh) links only json + fts, which pins DuckDB to UTC.",
            });
        }
    });

/** The read half of the service, over an already-resolved connection getter. */
const readerOver = (
    connect: Effect.Effect<DuckDbConnection, CacheUnavailableError>,
    path: string,
): CacheReadService => {
    const raw: CacheReadService["raw"] = (sql, params) =>
        Effect.flatMap(connect, (conn) => conn.query(sql, params));

    const rows: CacheReadService["rows"] = (schema, sql, params) =>
        Effect.flatMap(connect, (conn) => conn.queryAs(schema, sql, params));

    const first = <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ): Effect.Effect<Option.Option<S["Type"]>, CacheReadError, S["DecodingServices"]> =>
        Effect.map(rows(schema, sql, params), (all) =>
            all.length === 0 ? Option.none<S["Type"]>() : Option.some(all[0]!),
        );

    return { rows, first, raw, snapshotPath: path };
};

export interface CacheReadOptions extends DuckDbLiveOptions {
    /** Defaults to `AX_DUCKDB_SNAPSHOT` or `~/.ax/cache/ax-snapshot.duckdb`. */
    readonly snapshotPath?: string;
}

/**
 * A `CacheRead` over the published snapshot. Opens nothing until the first
 * query; memoizes the open on SUCCESS only (see the module header).
 */
export const CacheReadLayer = (options?: CacheReadOptions): Layer.Layer<CacheRead> =>
    Layer.effect(CacheRead)(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = options?.snapshotPath ?? defaultSnapshotPath();
            const liveOptions: DuckDbLiveOptions =
                options?.assetPath === undefined ? {} : { assetPath: options.assetPath };

            // Plain mutable cells rather than a Ref: everything that reads or
            // writes them happens inside one synchronous statement under the
            // gate below, so there is no interleaving to protect against, and a
            // Ref would only obscure that the finalizer needs to see them.
            let conn: DuckDbConnection | null = null;
            let closeLib: (() => void) | null = null;
            // One permit, so a burst of concurrent first-queries opens the
            // database ONCE instead of racing N dylib loads.
            const gate = Semaphore.makeUnsafe(1);

            yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                    if (conn !== null) yield* conn.close;
                    if (closeLib !== null) closeLib();
                }),
            );

            const openOnce = Effect.gen(function* () {
                if (conn !== null) return conn;
                const opened = yield* openDuckDbService(fs, liveOptions).pipe(
                    Effect.mapError(toUnavailable(path)),
                );
                const connection = yield* opened.db.open(path, { readOnly: true }).pipe(
                    // Do not leak the dylib handle when the database itself is
                    // the thing that will not open - the overwhelmingly common
                    // case, since "no snapshot yet" lands here.
                    Effect.tapError(() => Effect.sync(opened.close)),
                    Effect.mapError(toUnavailable(path)),
                );
                conn = connection;
                closeLib = opened.close;
                return connection;
            });

            const connect: Effect.Effect<DuckDbConnection, CacheUnavailableError> = Effect.suspend(() =>
                // Fast path: already open, no permit needed. Re-checked inside
                // the permit because two fibers can both miss it here.
                conn !== null ? Effect.succeed(conn) : gate.withPermits(1)(openOnce),
            );

            return readerOver(connect, path);
        }),
    ).pipe(Layer.provide(BunFileSystem.layer));

/** `CacheReadLayer()` with every default. */
export const CacheReadLive: Layer.Layer<CacheRead> = CacheReadLayer();

export interface CacheWriteOptions extends DuckDbLiveOptions {
    /** The live database ingest writes. */
    readonly livePath: string;
    /** The ingest lock that must be held. Same path `withIngestLock` took. */
    readonly lockPath: string;
    /** Where to publish on success. Defaults to the standard snapshot path. */
    readonly snapshotPath?: string;
    /** DDL applied before `body` runs. Every statement in schema.duckdb.sql is
     *  `IF NOT EXISTS`, so this is idempotent and makes the cache self-healing.
     *  Pass `null` to skip (a caller that knows the schema is already there). */
    readonly schemaSql: string | null;
}

/**
 * Run `body` with write access to the live cache, then publish a snapshot.
 *
 * The ONLY way to get a `CacheWriteService`. In order: refuse unless this
 * process holds the ingest lock; open the live database read-write; pin UTC;
 * apply the DDL; run `body`; publish the snapshot THROUGH THIS CONNECTION
 * (RULING R14 - a second handle on the same path is not guaranteed to see this
 * one's commits, which silently published a stale snapshot in wave 0) - and
 * publish ONLY if `body` succeeded, so a failed ingest can never replace a good
 * snapshot with a half-written one. The connection is closed on every path.
 */
export const withCacheWrite = <A, E, R>(
    options: CacheWriteOptions,
    body: (write: CacheWriteService) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CacheWriteError, R | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const target = options.snapshotPath ?? defaultSnapshotPath();
        const liveOptions: DuckDbLiveOptions =
            options.assetPath === undefined ? {} : { assetPath: options.assetPath };

        const held = yield* ingestLockHeldHere(options.lockPath);
        if (!held) {
            return yield* new CacheWriteUnlockedError({
                livePath: options.livePath,
                lockPath: options.lockPath,
                message:
                    `refusing to open ${options.livePath} for writing: this process does not hold the ingest ` +
                    `lock at ${options.lockPath}. Writes to the ax cache only happen inside ingest, under that ` +
                    "lock - wrap this call in withIngestLock (@ax/lib/ingest-lock).",
            });
        }

        const opened = yield* openDuckDbService(fs, liveOptions).pipe(
            Effect.mapError(toUnavailable(options.livePath)),
        );

        return yield* Effect.acquireUseRelease(
            opened.db.open(options.livePath, { readOnly: false }).pipe(
                Effect.tapError(() => Effect.sync(opened.close)),
                Effect.mapError(toUnavailable(options.livePath)),
            ),
            (conn) =>
                Effect.gen(function* () {
                    yield* assertUtcClock(conn, options.livePath);
                    if (options.schemaSql !== null) yield* conn.exec(options.schemaSql);

                    const write = writerOver(conn, options.livePath, target);
                    const value = yield* body(write);

                    // Publish LAST and only on success: a failed ingest must
                    // leave the previous snapshot exactly as it was.
                    yield* opened.db
                        .publishSnapshot(options.livePath, target, { from: conn })
                        .pipe(Effect.mapError((err) => toPublishError(err, target)));
                    return value;
                }),
            (conn) => conn.close.pipe(Effect.andThen(Effect.sync(opened.close))),
        );
    });

const toPublishError = (
    err: SnapshotPublishError | DuckDbOpenError,
    target: string,
): SnapshotPublishError =>
    err._tag === "SnapshotPublishError"
        ? err
        : new SnapshotPublishError({ snapshotPath: target, message: err.message });

/** Build the write service over an open read-write connection. */
const writerOver = (
    conn: DuckDbConnection,
    livePath: string,
    target: string,
): CacheWriteService => {
    const reader = readerOver(Effect.succeed(conn), target);

    const exec: CacheWriteService["exec"] = (sql, params) => conn.exec(sql, params);

    /** One `INSERT OR REPLACE` covering `rows`, all of which must share `columns`. */
    const insertStatement = (
        table: string,
        columns: ReadonlyArray<string>,
        stamped: string | undefined,
        rowCount: number,
    ): Effect.Effect<string, DuckDbQueryError> =>
        Effect.gen(function* () {
            const quotedTable = yield* quoteIdentifier("table", table);
            const quotedColumns: string[] = [];
            for (const column of columns) quotedColumns.push(yield* quoteIdentifier("column", column));

            const placeholders = columns.map(() => "?").join(", ");
            // The stamped column is NOT a bound parameter: it must be the
            // database's own clock (see WRITE_STAMPED_COLUMNS), which is what
            // the DDL default would have produced.
            const valuesForRow =
                stamped === undefined
                    ? `(${placeholders})`
                    : `(${placeholders}${placeholders.length > 0 ? ", " : ""}CURRENT_TIMESTAMP)`;
            const allColumns =
                stamped === undefined
                    ? quotedColumns
                    : [...quotedColumns, yield* quoteIdentifier("column", stamped)];

            return `INSERT OR REPLACE INTO ${quotedTable} (${allColumns.join(", ")}) VALUES ${Array.from(
                { length: rowCount },
                () => valuesForRow,
            ).join(", ")}`;
        });

    const putMany: CacheWriteService["putMany"] = (table, rows) =>
        Effect.gen(function* () {
            if (rows.length === 0) return;

            const stamped = WRITE_STAMPED_COLUMNS[table];
            // A caller-supplied value for a stamped column is dropped, not
            // honoured - that is the whole point of the stamp.
            const columnsOf = (row: Readonly<Record<string, DuckDbParam>>): ReadonlyArray<string> =>
                Object.keys(row).filter((c) => c !== stamped);

            const columns = columnsOf(rows[0]!);
            const signature = [...columns].sort().join(",");
            for (let i = 1; i < rows.length; i += 1) {
                const other = [...columnsOf(rows[i]!)].sort().join(",");
                if (other !== signature) {
                    return yield* new DuckDbQueryError({
                        sql: `INSERT OR REPLACE INTO ${table}`,
                        message:
                            `putMany requires every row to have the same columns, but row ${i} has [${other}] ` +
                            `while row 0 has [${signature}]. Split them into separate putMany calls - a ragged ` +
                            "batch would silently write NULLs into the columns a row omitted.",
                    });
                }
            }

            for (let start = 0; start < rows.length; start += PUT_BATCH_ROWS) {
                const batch = rows.slice(start, start + PUT_BATCH_ROWS);
                const sql = yield* insertStatement(table, columns, stamped, batch.length);
                const params = batch.flatMap((row) => columns.map((column) => row[column]));
                yield* conn.exec(sql, params);
            }
        });

    const put: CacheWriteService["put"] = (table, row) => putMany(table, [row]);

    return { ...reader, exec, put, putMany, livePath };
};
