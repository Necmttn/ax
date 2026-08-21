/**
 * THE SEAM. Every v2 reader and every v2 writer goes through this module, and
 * the two halves are deliberately not symmetrical:
 *
 *   READS  ({@link CacheRead})  open the PUBLISHED SNAPSHOT, read-only. They
 *          never touch the live database, so an ingest writing at full speed
 *          cannot slow a query down; a statement in flight when a publish lands
 *          finishes against the snapshot it started on, and the next statement
 *          picks the new one up (see {@link CacheReadLayer}).
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
 *  1. THE UTC PIN on every connection (`pinUtc`), plus a clock CHECK on every
 *     write connection (`assertUtcClock`). The DDL declares every TIMESTAMP
 *     column to be UTC, and both its `DEFAULT CURRENT_TIMESTAMP` columns and the
 *     stamped columns below take their value from the DATABASE's clock. If that
 *     clock were not UTC they would silently record local time. Pin first, then
 *     verify - see `pinUtc` for the measurement behind that order.
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
 * yet - `ax studio` and `ax mcp` build their layers at startup, long before anyone
 * runs a query - so NOTHING is opened at layer-build time. The first query opens
 * the dylib and the snapshot and remembers them. A FAILURE is deliberately not
 * remembered: the common shape is a process that started before the first ingest,
 * and it must pick the snapshot up once it appears rather than reporting "no
 * cache" for the rest of its life. The same argument applies AFTER the first
 * success - a memoized connection goes stale on the next publish - which is why
 * the memo is keyed on the snapshot's file identity rather than held forever.
 *
 * RULING R6: runtime module under `packages/lib/src/` - `node:fs` / `node:path`
 * are banned; filesystem access goes through `FileSystem.FileSystem`.
 */
import { BunFileSystem } from "@effect/platform-bun";
import { Context, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";
import { chargeStageSelfTime } from "./self-time.ts";
import { schemaCommentStatements } from "./schema-comments.ts";
import { stableDigest } from "../ids.ts";
import { ingestLockHeldHere } from "../ingest-lock.ts";
import {
    openDuckDbService,
    snapshotPath as defaultSnapshotPath,
    type DuckDbConnection,
    type DuckDbLiveOptions,
    type DuckDbService,
} from "./client.ts";
import {
    DuckDbDecodeError,
    DuckDbDylibError,
    DuckDbOpenError,
    DuckDbQueryError,
    DuckDbUnsupportedTypeError,
    SnapshotPublishError,
} from "./errors.ts";
import { stripNulParams } from "./nul-strip.ts";
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
    /**
     * How much this writer has had to scrub so far - see {@link nulStripTotals}
     * and `./nul-strip.ts`. Sanitising data behind a caller's back is exactly
     * the failure class this seam exists to prevent, so the mutation is
     * COUNTABLE: `withCacheWrite` logs a warning naming these numbers whenever
     * either is non-zero, and a caller (an ingest run reporting on itself) can
     * read them directly.
     */
    readonly nulStripped: () => NulStripTotals;
    /** Duplicate-id rows removed from `putMany` inputs. The last occurrence
     *  for each id is the row that the writer keeps. */
    readonly rowsCollapsed: () => ReadonlyMap<string, number>;
    /** The live database being written (not the snapshot). */
    readonly livePath: string;
}

/** Running totals of writer-side NUL stripping for one `withCacheWrite` body. */
export interface NulStripTotals {
    /** Bound text values that carried at least one U+0000 and were scrubbed. */
    readonly values: number;
    /** Statements at least one of those values belonged to. */
    readonly statements: number;
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
 * Pin this connection's session time zone to UTC. Best-effort by design, and
 * ALWAYS followed by {@link assertUtcClock} on the write path: the pin is the
 * fix, the assert is the proof.
 *
 * WHY BOTH, with the measurement. DuckDB's `CURRENT_TIMESTAMP` is a TIMESTAMPTZ,
 * and storing it into a naive TIMESTAMP column converts it through the session's
 * `TimeZone`. `TimeZone` is a setting the `icu` extension registers, so the two
 * builds ax runs against behave differently - measured under `TZ=Asia/Makassar`
 * (UTC+8), reading back `CAST(CURRENT_TIMESTAMP AS TIMESTAMP)` and a DDL
 * `DEFAULT CURRENT_TIMESTAMP` column:
 *
 *   - OFFICIAL v1.5.5 build (icu linked - what `vendor/duckdb/` downloads and
 *     what CI runs): `TimeZone` IS in the catalog and defaults to the HOST zone.
 *     Unpinned, both values land 480 minutes off - local wall time in a column
 *     the DDL declares UTC. `SET TimeZone='UTC'` succeeds and brings both to 0.
 *   - ax's own build (`scripts/build-duckdb.sh`, only `json` + `fts`): the
 *     statement FAILS with "Setting with name TimeZone is not in the catalog",
 *     and without icu DuckDB has no time-zone database at all, so it renders
 *     TIMESTAMPTZ in UTC unconditionally - already correct, nothing to pin.
 *
 * So the failure is ignored: on the only build that rejects the statement, the
 * property it would have established already holds. Nothing is assumed either
 * way - `assertUtcClock` then measures the PROPERTY ("what the database stores
 * as now() is UTC now") on every write connection, so a build or a setting that
 * defeats the pin is a loud typed refusal rather than silent local timestamps.
 *
 * RETRACTION: an earlier version of this module asserted WITHOUT pinning, on the
 * claim that `SET TimeZone='UTC'` was "unnecessary and actively broken". That was
 * measured against ax's own icu-less build only. Against the official build the
 * statement works and IS necessary, and asserting alone turned a wrong timestamp
 * into a refusal of every single write on any non-UTC host.
 */
const pinUtc = (conn: DuckDbConnection): Effect.Effect<void> =>
    Effect.ignore(conn.exec("SET TimeZone='UTC'"));

/**
 * Prove the database's own clock lands in UTC before writing anything with it.
 * Runs AFTER {@link pinUtc}, so a failure here means the pin did not take.
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
                    "this schema is declared UTC, so writing now would silently store local time. This connection " +
                    "was already pinned with `SET TimeZone='UTC'` (see pinUtc), so the gap means either that " +
                    "statement did not take against this libduckdb build or the host clock itself is wrong.",
            });
        }
    });

/**
 * Borrow the connection for the duration of ONE statement. The read layer swaps
 * connections underneath (see {@link CacheReadLayer}), so a statement must hold
 * the handle it was issued against rather than re-resolving it.
 */
type WithConnection = <A, E, R>(
    use: (conn: DuckDbConnection) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | CacheUnavailableError, R>;

/** The read half of the service, over a connection-borrowing combinator. */
const readerOver = (withConnection: WithConnection, path: string): CacheReadService => {
    // Every statement is charged to the stage that issued it, if any - see
    // ./self-time.ts for why per-stage wall clock cannot be read as cost.
    const raw: CacheReadService["raw"] = (sql, params) =>
        chargeStageSelfTime(withConnection((conn) => conn.query(sql, params)));

    const rows: CacheReadService["rows"] = (schema, sql, params) =>
        chargeStageSelfTime(withConnection((conn) => conn.queryAs(schema, sql, params)));

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
    /** Defaults to `defaultSnapshotPath()`: `AX_DUCKDB_SNAPSHOT`, else
     *  `AX_DATA_DIR`-rooted, else `~/.ax/cache/ax-snapshot.duckdb`. */
    readonly snapshotPath?: string;
}

/**
 * One open snapshot, plus the file identity it was opened on and the number of
 * statements currently running against it.
 */
interface SnapshotHandle {
    readonly conn: DuckDbConnection;
    /** `dev:ino:size:mtime` of the file this connection actually opened. */
    readonly identity: string;
    /** Statements in flight. A retired handle is closed when this reaches 0. */
    inFlight: number;
    /** A newer snapshot has been published and opened; this one is on its way out. */
    retired: boolean;
}

/**
 * The published snapshot's FILE IDENTITY, or `null` when it cannot be read
 * (removed, permissions, a filesystem that will not answer).
 *
 * `ino` is the load-bearing part: a publish `rename`s a NEW file over the path,
 * so the inode changes even when size and mtime happen to coincide. Size and
 * mtime ride along for filesystems that do not report an inode.
 */
const snapshotIdentity = (
    fs: FileSystem.FileSystem,
    path: string,
): Effect.Effect<string | null> =>
    fs.stat(path).pipe(
        Effect.map((info) => {
            const ino = Option.getOrElse(info.ino, () => 0);
            const mtime = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
            return `${info.dev}:${ino}:${info.size}:${mtime}`;
        }),
        Effect.orElseSucceed(() => null),
    );

/**
 * A `CacheRead` over the published snapshot. Opens nothing until the first
 * query; memoizes the open on SUCCESS only (see the module header).
 *
 * AND REOPENS WHEN THE SNAPSHOT IS REPUBLISHED. A publish renames a new file
 * over the snapshot path, so a connection held across it keeps reading the OLD
 * inode - and `ax studio` / `ax mcp` hold ONE `CacheRead` for the whole process
 * lifetime, so every request after the first ingest answered stale data until
 * the process restarted. Each statement therefore checks the file identity first
 * (one `stat`, ~tens of microseconds against a >100ms query budget) and reopens
 * when it changed.
 *
 * The old connection is NOT closed at that moment: a statement already running
 * against it would get "the connection is closed" instead of its rows. It is
 * RETIRED and closed when its last in-flight statement lets go - which is also
 * why a statement borrows its handle for its whole duration rather than
 * re-resolving the current one mid-flight.
 *
 * A snapshot that cannot be `stat`ed (a publish's rename window, a removed file)
 * keeps the current handle rather than tearing a working reader down.
 */
export const CacheReadLayer = (options?: CacheReadOptions): Layer.Layer<CacheRead> =>
    Layer.effect(CacheRead)(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = options?.snapshotPath ?? defaultSnapshotPath();
            const liveOptions: DuckDbLiveOptions = {
                ...(options?.assetPath === undefined ? {} : { assetPath: options.assetPath }),
                ...(options?.nodeBindingAssetPath === undefined
                    ? {}
                    : { nodeBindingAssetPath: options.nodeBindingAssetPath }),
            };

            // Plain mutable cells rather than a Ref: every read/write of them
            // below happens inside one synchronous statement (never straddling a
            // yield), and a Ref would only obscure that the finalizer needs to
            // see them.
            let lib: { readonly db: DuckDbService; readonly close: () => void } | null = null;
            let current: SnapshotHandle | null = null;
            const retiring = new Set<SnapshotHandle>();
            // One permit, so a burst of concurrent first-queries (or of queries
            // that all notice the same new snapshot) opens the database ONCE
            // instead of racing N opens.
            const gate = Semaphore.makeUnsafe(1);

            yield* Effect.addFinalizer(() =>
                Effect.gen(function* () {
                    for (const handle of retiring) yield* handle.conn.close;
                    retiring.clear();
                    if (current !== null) yield* current.conn.close;
                    if (lib !== null) lib.close();
                }),
            );

            /** Close a retired handle once nothing is reading through it. */
            const closeIfIdle = (handle: SnapshotHandle): Effect.Effect<void> =>
                Effect.suspend(() => {
                    if (!handle.retired || handle.inFlight > 0) return Effect.void;
                    retiring.delete(handle);
                    return handle.conn.close;
                });

            /** The dylib, loaded once. A load FAILURE is not remembered (D5). */
            const openedLib = Effect.suspend(() =>
                lib !== null
                    ? Effect.succeed(lib)
                    : openDuckDbService(fs, liveOptions).pipe(
                          Effect.mapError(toUnavailable(path)),
                          Effect.tap((opened) => Effect.sync(() => (lib = opened))),
                      ),
            );

            const openSnapshot = (identity: string | null) =>
                Effect.gen(function* () {
                    const opened = yield* openedLib;
                    const conn = yield* opened.db.open(path, { readOnly: true }).pipe(
                        Effect.mapError(toUnavailable(path)),
                    );
                    // Pin the session zone on readers too: an icu-linked build
                    // otherwise evaluates CURRENT_TIMESTAMP (and any comparison
                    // against it) at LOCAL wall time - see `pinUtc`.
                    yield* pinUtc(conn);
                    // Re-stat AFTER the open when the pre-check could not answer,
                    // so the handle always carries the identity it really opened.
                    const opened_identity = identity ?? (yield* snapshotIdentity(fs, path));
                    return {
                        conn,
                        identity: opened_identity ?? "unknown",
                        inFlight: 0,
                        retired: false,
                    } satisfies SnapshotHandle;
                });

            /** Claim a handle for one statement, reopening if the file changed. */
            const claim: Effect.Effect<SnapshotHandle, CacheUnavailableError> = Effect.gen(function* () {
                const identity = yield* snapshotIdentity(fs, path);
                const open = current;
                // Fast path: the snapshot on disk is the one we have open.
                // Re-checked under the permit, because two fibers can both miss.
                if (open !== null && (identity === null || identity === open.identity)) {
                    open.inFlight += 1;
                    return open;
                }
                return yield* gate.withPermits(1)(
                    Effect.gen(function* () {
                        const held = current;
                        const fresh = yield* snapshotIdentity(fs, path);
                        if (held !== null && (fresh === null || fresh === held.identity)) {
                            held.inFlight += 1;
                            return held;
                        }
                        // Opened BEFORE retiring the old handle, so a failed
                        // reopen leaves the working reader exactly as it was.
                        const handle = yield* openSnapshot(fresh);
                        if (held !== null) {
                            held.retired = true;
                            retiring.add(held);
                            yield* closeIfIdle(held);
                        }
                        current = handle;
                        handle.inFlight += 1;
                        return handle;
                    }),
                );
            });

            const release = (handle: SnapshotHandle): Effect.Effect<void> =>
                Effect.suspend(() => {
                    handle.inFlight -= 1;
                    return closeIfIdle(handle);
                });

            const withConnection: WithConnection = (use) =>
                Effect.acquireUseRelease(claim, (handle) => use(handle.conn), release);

            return readerOver(withConnection, path);
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
    /**
     * Whether a successful `body` publishes a snapshot. Defaults to `true` -
     * the ingest path, where publishing IS the point.
     *
     * MAINTENANCE WRITES MUST PASS `false`, and the reason is a real defect this
     * flag exists to make unrepresentable. Publishing is gated on "did `body`
     * succeed", which reads as "did the INGEST succeed" only while the ingest is
     * the sole thing opening this seam. It is not: the CLI stamps the
     * `ingest_run` row from an `onTimeout` hook, and GCs blobs from `afterWork`,
     * each through its OWN `withCacheWrite`. Those bodies are one-statement
     * writes that succeed even when the ingest they are reporting on TIMED OUT,
     * so with the default they publish the live database as the timed-out run
     * left it - derived tables computed over half-written base tables, and no
     * FTS index (`buildFtsIndexes` runs at the END of `runIngest`). Ingest also
     * runs without a transaction, so there is no rollback to fall back on: the
     * partial rows are committed, and publishing hands them to every CLI, MCP
     * and dashboard read as the authoritative snapshot.
     *
     * The rule the flag encodes: publish when you wrote the DATA, never when you
     * only wrote a note ABOUT the data.
     */
    readonly publish?: boolean;
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
        const liveOptions: DuckDbLiveOptions = {
            ...(options.assetPath === undefined ? {} : { assetPath: options.assetPath }),
            ...(options.nodeBindingAssetPath === undefined
                ? {}
                : { nodeBindingAssetPath: options.nodeBindingAssetPath }),
        };

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
                    yield* pinUtc(conn);
                    yield* assertUtcClock(conn, options.livePath);
                    if (options.schemaSql !== null) {
                        yield* conn.exec(options.schemaSql);
                        // Self-documenting catalog (#869): mirror the DDL's own
                        // `--` prose into COMMENT ON statements so agents can
                        // introspect meaning via duckdb_columns() instead of
                        // trusting docs that drift. Idempotent like the DDL.
                        const comments = schemaCommentStatements(options.schemaSql);
                        if (comments.length > 0) {
                            const commentsHash = stableDigest(comments);
                            // The seam owns its bookkeeping table (also declared
                            // in schema.duckdb.sql for the record): callers pass
                            // arbitrary DDL (tests, partial schemas) and the
                            // gate must work against all of them.
                            yield* conn.exec(
                                "CREATE TABLE IF NOT EXISTS schema_comment_state (" +
                                    "id VARCHAR PRIMARY KEY, comments_hash VARCHAR NOT NULL, " +
                                    "applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
                            );
                            const stored = (yield* conn.query(
                                "SELECT comments_hash FROM schema_comment_state WHERE id = 'comments'",
                            )).rows[0]?.comments_hash;
                            if (stored !== commentsHash) {
                                yield* conn.exec(comments);
                                yield* conn.query(
                                    "INSERT OR REPLACE INTO schema_comment_state (id, comments_hash, applied_at) VALUES ('comments', ?, CURRENT_TIMESTAMP)",
                                    [commentsHash],
                                );
                                // CHECKPOINT immediately: COMMENT ON records left
                                // in the WAL poison crash recovery in this DuckDB
                                // build (replay fails with "GetDefaultDatabase
                                // with no default database set", leaving the live
                                // db unopenable). Folding them into the main file
                                // at once means a later crash's WAL never
                                // contains one - and the hash gate above keeps
                                // every routine open comment-free entirely.
                                yield* conn.exec("CHECKPOINT");
                            }
                        }
                    }

                    const write = writerOver(conn, options.livePath, target);
                    // Reported on EVERY exit path (`ensuring`), not just a
                    // successful one: a body that scrubbed rows and then failed
                    // for an unrelated reason still changed data on the way
                    // through, and that is precisely when an operator needs to
                    // know it happened.
                    const value = yield* body(write).pipe(
                        Effect.ensuring(reportNulStripped(write, options.livePath)),
                        Effect.ensuring(reportRowsCollapsed(write, options.livePath)),
                    );

                    // Publish LAST and only on success: a failed ingest must
                    // leave the previous snapshot exactly as it was. A
                    // maintenance caller opts OUT entirely (see `publish`) -
                    // its body succeeding says nothing about the state of the
                    // database it would be publishing.
                    if (options.publish !== false) {
                        const safe = yield* publishWouldNotDestroyData(fs, conn, target);
                        if (safe) {
                            yield* opened.db
                                .publishSnapshot(options.livePath, target, { from: conn })
                                .pipe(Effect.mapError((err) => toPublishError(err, target)));
                        }
                    }
                    return value;
                }),
            (conn) => conn.close.pipe(Effect.andThen(Effect.sync(opened.close))),
        );
    });

/** Escape hatch for the empty-publish guard below. Only a caller that MEANS to
 *  replace a populated snapshot with an empty one should set it. */
const ALLOW_EMPTY_PUBLISH_ENV = "AX_ALLOW_EMPTY_PUBLISH";

/**
 * Refuse to replace a POPULATED snapshot with an EMPTY one.
 *
 * This is a data-loss backstop, and it is here because the failure it prevents
 * has now happened five times to a real store. The published snapshot went to
 * zero rows while the live database kept everything, and every read surface
 * afterwards answered "no data" instead of failing - the worst shape of bug this
 * project produces, because exit code 0 makes it look like an answer.
 *
 * `snapshotPath()` honouring `AX_DATA_DIR` (the fix for the first four) closed
 * the path-asymmetry route. It did NOT close the class: ANY process that opens a
 * fresh live database and publishes with the default target still overwrites the
 * real snapshot, and on the fifth occurrence the culprit could not be identified
 * afterwards at all. So this guard deliberately does not care WHO is publishing
 * or WHY. It compares outcomes, which is the only thing that reliably
 * distinguishes a rebuild from a wipe.
 *
 * THE RULE IS NARROW ON PURPOSE: refuse only when the incoming database has zero
 * sessions and the existing snapshot has some. That cannot fire on any honest
 * run - a store with data keeps publishing normally, a first publish onto no
 * snapshot is allowed, an empty-onto-empty publish is allowed, and `ax ingest
 * --reset` only clears skill tables so its sessions survive. A "refuse if much
 * smaller" heuristic was rejected: it needs a threshold, and a threshold is a
 * guess that either fires on a legitimate prune or misses a partial wipe.
 *
 * Failure to EVALUATE the guard is not failure to publish: an unreadable or
 * corrupt existing snapshot returns `true` (publish proceeds), because refusing
 * to publish over a file we cannot read would wedge recovery.
 */
const publishWouldNotDestroyData = (
    fs: FileSystem.FileSystem,
    conn: DuckDbConnection,
    target: string,
): Effect.Effect<boolean> =>
    Effect.gen(function* () {
        if ((process.env[ALLOW_EMPTY_PUBLISH_ENV] ?? "").trim().length > 0) return true;

        const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return true; // first publish - nothing to lose

        const incoming = yield* sessionCount(conn).pipe(Effect.orElseSucceed(() => -1));
        // Only an unambiguously EMPTY incoming database can trip the guard. -1
        // means the count could not be read, which is not evidence of emptiness.
        if (incoming !== 0) return true;

        const existing = yield* countSessionsIn(conn, target).pipe(Effect.orElseSucceed(() => 0));
        if (existing <= 0) return true; // empty over empty: no loss either way

        yield* Effect.logError(
            `ax cache: REFUSED to publish an empty snapshot over a populated one - ` +
                `the incoming database has 0 sessions and ${target} has ${existing}. ` +
                `The existing snapshot is untouched and your data is safe. ` +
                `This usually means a process opened a FRESH live database and published ` +
                `with the default target: pin AX_DUCKDB_SNAPSHOT (or AX_DATA_DIR) for ` +
                `isolated runs, or pass 'publish: false' for a maintenance write. ` +
                `Set ${ALLOW_EMPTY_PUBLISH_ENV}=1 if replacing it is genuinely what you want.`,
        );
        return false;
    });

/** Sessions in the database this connection is attached to. */
const sessionCount = (
    conn: DuckDbConnection,
): Effect.Effect<number, DuckDbQueryError | DuckDbUnsupportedTypeError> =>
    conn.query("SELECT CAST(count(*) AS DOUBLE) AS n FROM session").pipe(
        // Rows are keyed by COLUMN NAME, not position - `rows[0][0]` is
        // `undefined`, which would silently read every count as 0 and turn this
        // guard into a no-op. The projection casts to DOUBLE so no BIGINT
        // reaches JS as a bigint (see CLAUDE.md on `raw`).
        Effect.map((result) => Number(result.rows[0]?.n ?? 0)),
    );

/** Sessions in ANOTHER database file, read-only, without disturbing it. The
 *  alias is unlikely to collide and is detached on every exit path. */
const countSessionsIn = (
    conn: DuckDbConnection,
    path: string,
): Effect.Effect<number, DuckDbQueryError | DuckDbUnsupportedTypeError> =>
    Effect.acquireUseRelease(
        conn.exec(`ATTACH '${path.replace(/'/g, "''")}' AS ax_publish_guard (READ_ONLY)`),
        () =>
            conn.query("SELECT CAST(count(*) AS DOUBLE) AS n FROM ax_publish_guard.session").pipe(
                Effect.map((result) => Number(result.rows[0]?.n ?? 0)),
            ),
        () => conn.exec("DETACH ax_publish_guard").pipe(Effect.ignore),
    );

/**
 * Say out loud what the writer changed. Silent sanitisation is the failure mode
 * this whole guard exists to avoid, so a run that stripped NUL bytes says so -
 * once, with totals, rather than a line per value (a single ingest can scrub
 * thousands, and a warning per row would bury everything else).
 *
 * A no-op when nothing was scrubbed, which is the normal case.
 */
const reportNulStripped = (write: CacheWriteService, livePath: string): Effect.Effect<void> =>
    Effect.suspend(() => {
        const totals = write.nulStripped();
        if (totals.values === 0) return Effect.void;
        return Effect.logWarning(
            `ax cache: stripped NUL bytes (U+0000) from ${totals.values} text value(s) across ` +
                `${totals.statements} statement(s) while writing ${livePath}. DuckDB VARCHARs are bound ` +
                "through a NUL-terminated C string, so such a value would otherwise be silently truncated " +
                "at the first NUL; the rest of each value was stored intact.",
        );
    });

/** Report duplicate-id rows that `putMany` collapsed before it wrote them. */
const reportRowsCollapsed = (write: CacheWriteService, livePath: string): Effect.Effect<void> =>
    Effect.suspend(() => {
        const byTable = write.rowsCollapsed();
        const rows = [...byTable.values()].reduce((total, count) => total + count, 0);
        if (rows === 0) return Effect.void;
        const topTables = [...byTable.entries()]
            .sort(([leftTable, leftCount], [rightTable, rightCount]) =>
                rightCount - leftCount || leftTable.localeCompare(rightTable),
            )
            .slice(0, 5)
            .map(([table, count]) => `${table}=${count}`)
            .join(", ");
        return Effect.logWarning(
            `ax cache: collapsed ${rows} duplicate-id row(s) before putMany batching while writing ${livePath}; ` +
                `top tables: ${topTables}; the last occurrence for each id was kept.`,
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
    // The writer owns exactly one connection for its whole lifetime, so
    // "borrowing" it is just calling with it - no identity check, no reopen: a
    // writer must keep reading the LIVE database it is writing.
    const reader = readerOver((use) => use(conn), target);

    /**
     * THE NUL CHOKE POINT (#790). Every write this seam issues - `exec`, `put`,
     * `putMany` - funnels through here, and it is the narrowest place that can
     * hold the rule: it is the last code that owns the parameter array before
     * `client.ts` binds it, and it is on the writer's side of the read/write
     * split, so the READ path (`reader` above, sharing this same connection) is
     * untouched. Scrubbing per call site instead would mean auditing every one
     * of the ~90 modules that hold a `CacheWriteService` and re-auditing every
     * new one.
     *
     * The strip itself, and why strip rather than escape, lives in
     * `./nul-strip.ts`. What lives here is the ACCOUNTING: a silent sanitiser
     * is how the original defect class got here, so the counts are kept and
     * reported (see `nulStripped` on the service and the warning in
     * `withCacheWrite`).
     */
    let nulValues = 0;
    let nulStatements = 0;
    const collapsedRows = new Map<string, number>();
    const execScrubbed = (
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ): Effect.Effect<number, DuckDbQueryError | DuckDbUnsupportedTypeError> => {
        if (params === undefined || params.length === 0) return conn.exec(sql, params);
        const stripped = stripNulParams(params);
        if (stripped.values > 0) {
            nulValues += stripped.values;
            nulStatements += 1;
        }
        return conn.exec(sql, stripped.params);
    };

    const exec: CacheWriteService["exec"] = (sql, params) =>
        chargeStageSelfTime(execScrubbed(sql, params));

    /**
     * One upsert covering `rows`, all of which must share `columns`.
     *
     * The conflict target is stated EXPLICITLY, and it has to be. The obvious
     * spelling - `INSERT OR REPLACE` - is DuckDB shorthand for "conflict on
     * whichever unique constraint the table has", and it fails outright with
     * "Conflict target has to be provided for a DO UPDATE operation when the
     * table has multiple UNIQUE/PRIMARY KEY constraints" the moment a table
     * carries a secondary unique index on top of its primary key. Most of this
     * schema does: `turn` has `turn_session_seq`, `commit` has `commit_sha_uq`,
     * `skill` has `skill_name_uq`, and forty-odd more. Naming `id` also states
     * the intent that shorthand left ambiguous: a re-ingest REPLACES the row
     * with the same content-hashed id, and a row that collides on a NATURAL key
     * while carrying a different id is a constraint violation the caller should
     * see, not a silent overwrite of a different row.
     *
     * `id VARCHAR PRIMARY KEY` on every table is a schema-wide invariant (see
     * schema.duckdb.sql's ROW IDS header), and a row without one is refused
     * below rather than inserted un-upsertably.
     */
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

            const updates = allColumns
                .filter((column) => column !== '"id"')
                .map((column) => `${column} = excluded.${column}`);
            // A row that is nothing but its id has no column left to update, and
            // `DO UPDATE SET` with an empty list is a syntax error.
            const onConflict =
                updates.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${updates.join(", ")}`;

            return `INSERT INTO ${quotedTable} (${allColumns.join(", ")}) VALUES ${Array.from(
                { length: rowCount },
                () => valuesForRow,
            ).join(", ")} ON CONFLICT ("id") ${onConflict}`;
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
            if (!columns.includes("id")) {
                return yield* new DuckDbQueryError({
                    sql: `INSERT INTO ${table}`,
                    message:
                        `putMany into ${table} needs an \`id\` on every row: every table in this schema is keyed ` +
                        "by `id VARCHAR PRIMARY KEY`, and the upsert names it as the conflict target. Rows given " +
                        `were missing it, so re-running ingest would append duplicates instead of replacing. Got [${columns.join(
                            ", ",
                        )}].`,
                });
            }
            const signature = [...columns].sort().join(",");
            for (let i = 1; i < rows.length; i += 1) {
                const other = [...columnsOf(rows[i]!)].sort().join(",");
                if (other !== signature) {
                    return yield* new DuckDbQueryError({
                        sql: `INSERT INTO ${table}`,
                        message:
                            `putMany requires every row to have the same columns, but row ${i} has [${other}] ` +
                            `while row 0 has [${signature}]. Split them into separate putMany calls - a ragged ` +
                            "batch would silently write NULLs into the columns a row omitted.",
                    });
                }
            }

            const rowsById = new Map<DuckDbParam, Readonly<Record<string, DuckDbParam>>>();
            for (const row of rows) rowsById.set(row["id"], row);
            const deduplicated = [...rowsById.values()];
            const collapsed = rows.length - deduplicated.length;
            if (collapsed > 0) {
                collapsedRows.set(table, (collapsedRows.get(table) ?? 0) + collapsed);
            }

            for (let start = 0; start < deduplicated.length; start += PUT_BATCH_ROWS) {
                const batch = deduplicated.slice(start, start + PUT_BATCH_ROWS);
                const sql = yield* insertStatement(table, columns, stamped, batch.length);
                const params = batch.flatMap((row) => columns.map((column) => row[column]));
                yield* chargeStageSelfTime(execScrubbed(sql, params));
            }
        });

    const put: CacheWriteService["put"] = (table, row) => putMany(table, [row]);

    const nulStripped = (): NulStripTotals => ({ values: nulValues, statements: nulStatements });
    const rowsCollapsed = (): ReadonlyMap<string, number> => new Map(collapsedRows);

    return { ...reader, exec, put, putMany, nulStripped, rowsCollapsed, livePath };
};
