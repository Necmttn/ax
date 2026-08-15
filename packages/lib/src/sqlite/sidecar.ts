// packages/lib/src/sqlite/sidecar.ts
/**
 * THE JUDGMENT SEAM. Every v2 read and every v2 write of durable judgment -
 * proposals, verdicts, role tags and weights, retros, triage calls, label
 * reviews, dogfood results, spar labels - goes through this module.
 *
 * READ IT AGAINST ITS SIBLING, `@ax/lib/duckdb/seam`. That one is deliberately
 * ASYMMETRICAL: reads open a published snapshot read-only, writes happen only
 * inside ingest under the ingest lock, and there is no other way to obtain a
 * writer. This one is deliberately SYMMETRICAL - one service, read and write,
 * available to any command at any time - and the difference is the entire reason
 * the sidecar exists:
 *
 *   - The cache is REBUILDABLE and huge. Its writes are a batch job (ingest),
 *     so serialising them behind a lock costs nothing and buys atomic publish.
 *   - Judgment is DURABLE and tiny. Its writes are REQUEST-TIME: `ax improve
 *     accept`, `ax skills tag`, `ax retro emit`, a dashboard triage click. There
 *     is no ingest run to attach them to. Making a user take the ingest lock to
 *     record a decision - or worse, wait for the next ingest - is not a policy,
 *     it is a bug, and it is why several wave-2 CLI and dashboard ports were
 *     blocked until this module existed.
 *
 * WHAT THIS SEAM OWNS THAT THE DDL CANNOT SAY:
 *
 *  1. PARAMETER NORMALISATION. SQLite has no Date and no boolean. A caller binds
 *     a JS `Date` and it is stored as the ISO-8601 UTC text the DDL declares; a
 *     caller binds `true` and it is stored as 1. Without this every writer would
 *     hand-roll `.toISOString()` and `? 1 : 0`, and the first one to forget
 *     writes a local-time string that reads back hours wrong (see
 *     `TimestampColumn` in ./columns.ts for that failure in full).
 *  2. TRANSACTIONS THAT SPAN AN EFFECT. `bun:sqlite`'s own `db.transaction()`
 *     takes a SYNCHRONOUS function, which no Effect body is. {@link transaction}
 *     drives `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` around an arbitrary effect
 *     instead - see its docstring for why IMMEDIATE and why one permit.
 *  3. Identifier quoting and validation, for the same reason the cache seam owns
 *     it: a table or column name is the one part of a statement that cannot be a
 *     bound parameter.
 *
 * WAL, AND WHY THE SIDECAR CAN BE OPEN IN TWO PROCESSES AT ONCE. `ax serve`
 * holds the sidecar open for the dashboard while the user runs `ax improve
 * accept` in a terminal. Under SQLite's default rollback journal the writer
 * would block every reader for the duration of its transaction; under WAL,
 * readers never block and never see a partial transaction. `busy_timeout` then
 * covers the one case WAL does not - two WRITERS - by waiting rather than
 * failing, because a judgment write that loses a millisecond race should retry,
 * not report an error to the user.
 *
 * RULING R6: runtime module under `packages/lib/src/` - `node:fs` / `node:path`
 * are banned; filesystem access goes through `FileSystem.FileSystem`. `bun:sqlite`
 * is fine (this package is Bun-only regardless, as `bun:ffi` already is), and
 * `node:os` `homedir()` is not banned - {@link sidecarPath}'s default uses it.
 */
import { BunFileSystem } from "@effect/platform-bun";
import { Database } from "bun:sqlite";
import { Context, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect";
import { homedir } from "node:os";
import { posixPath } from "../shared/path.ts";
import {
    errorMessage,
    SidecarDecodeError,
    SidecarQueryError,
    SidecarUnavailableError,
    sqlExcerpt,
    type JudgmentError,
} from "./errors.ts";

/**
 * What a caller may bind. `Date` and `boolean` are in the list because the seam
 * normalises them (see {@link toBindable}); `undefined` is NOT, so a row built
 * from an optional field that turned out absent is a type error at the call site
 * rather than a silent NULL in a judgment row.
 */
export type SidecarParam = string | number | bigint | boolean | Date | Uint8Array | null;

/** A raw cell as SQLite hands it back. */
export type SidecarValue = string | number | bigint | Uint8Array | null;

export type SidecarRow = Readonly<Record<string, SidecarValue>>;

export interface JudgmentService {
    /** Every row, decoded through `schema`. Use the named column codecs in
     *  `./columns.ts` so the decode contract is explicit at the call site. */
    readonly rows: <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<SidecarParam>,
    ) => Effect.Effect<ReadonlyArray<S["Type"]>, JudgmentError, S["DecodingServices"]>;
    /** The first row, or `none`. A second row is NOT an error - callers that
     *  want one row write `LIMIT 1`; this is about absence, not cardinality. */
    readonly first: <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<SidecarParam>,
    ) => Effect.Effect<Option.Option<S["Type"]>, JudgmentError, S["DecodingServices"]>;
    /** Undecoded rows, for shapes no schema fits (a `PRAGMA`, a runtime-built
     *  aggregate). */
    readonly raw: (
        sql: string,
        params?: ReadonlyArray<SidecarParam>,
    ) => Effect.Effect<ReadonlyArray<SidecarRow>, JudgmentError>;
    /** Rows changed. */
    readonly exec: (
        sql: string,
        params?: ReadonlyArray<SidecarParam>,
    ) => Effect.Effect<number, JudgmentError>;
    /** Upsert one row, keyed on `id`. */
    readonly put: (
        table: string,
        row: Readonly<Record<string, SidecarParam>>,
    ) => Effect.Effect<void, JudgmentError>;
    /** {@link put} for many rows of the SAME SHAPE, batched into multi-row
     *  INSERTs. Rows with differing column sets are a typed refusal, not a
     *  silently-ragged insert. */
    readonly putMany: (
        table: string,
        rows: ReadonlyArray<Readonly<Record<string, SidecarParam>>>,
    ) => Effect.Effect<void, JudgmentError>;
    /**
     * Run `body` inside ONE transaction: committed if it succeeds, rolled back
     * if it fails or is interrupted.
     */
    readonly transaction: <A, E, R>(
        body: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | JudgmentError, R>;
    /** The sidecar file this service is bound to (resolved, not the spelling). */
    readonly path: string;
}

export class Judgment extends Context.Service<Judgment, JudgmentService>()("ax/Judgment") {}

/** `AX_SIDECAR_PATH`, or `~/.ax/judgment.sqlite`.
 *
 *  NOT under `~/.ax/cache/`, and that placement is the contract: everything in
 *  that directory is safe to delete and re-derive, and this file is the one
 *  thing in ax that is not. */
export const sidecarPath = (): string => {
    const override = process.env.AX_SIDECAR_PATH?.trim();
    return override ? override : posixPath.join(homedir(), ".ax", "judgment.sqlite");
};

/** The identifier shape this seam will emit. Anything else is refused rather
 *  than quoted-and-hoped. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const quoteIdentifier = (
    kind: "table" | "column",
    name: string,
): Effect.Effect<string, SidecarQueryError> =>
    IDENTIFIER.test(name)
        ? Effect.succeed(`"${name}"`)
        : Effect.fail(
              new SidecarQueryError({
                  sql: "",
                  message: `refusing to build a statement with the ${kind} name ${JSON.stringify(
                      name,
                  )}: a ${kind} name cannot be a bound parameter, so this seam only emits names matching ${IDENTIFIER}`,
              }),
          );

/** How many rows one `putMany` statement carries. SQLite's default parameter
 *  limit is 32766 (SQLITE_MAX_VARIABLE_NUMBER since 3.32), so 200 rows leaves
 *  headroom for a table well past this schema's widest (dogfood_run, 19). */
const PUT_BATCH_ROWS = 200;

/**
 * Normalise one bound value to something `bun:sqlite` accepts, applying the two
 * conversions the DDL's types imply (see the TYPES block in schema.sidecar.sql).
 */
const toBindable = (value: SidecarParam): SidecarValue => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
};

export interface JudgmentLayerOptions {
    /**
     * DDL applied on open. REQUIRED, and the caller supplies the text, because
     * `@ax/lib` deliberately has no RUNTIME dependency on `@ax/schema` - the DDL
     * lives in the schema package and importing it here would create a package
     * cycle (see the note in ../stable-id.ts, and `CacheWriteOptions.schemaSql`,
     * which is required for the same reason). Pass `SIDECAR_SCHEMA_SQL` from
     * `@ax/schema/sidecar-ddl`; every statement in it is `IF NOT EXISTS`, so
     * applying it on every open is idempotent and makes the sidecar
     * self-healing. Pass `null` to skip it.
     */
    readonly schemaSql: string | null;
    /** Defaults to {@link sidecarPath}. */
    readonly sidecarPath?: string;
    /** How long a write waits for another writer before failing. */
    readonly busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Build the service over an open database. Split out from the layer so the
 *  service's behaviour is testable without the lazy-open machinery around it. */
const serviceOver = (db: Database, path: string): JudgmentService => {
    // ONE permit, held for the whole of a transaction. SQLite transactions are a
    // property of the CONNECTION, not of a call: two fibers interleaving
    // BEGIN/COMMIT on this shared handle would commit each other's work and roll
    // back each other's. The permit makes "a transaction is exclusive on this
    // connection" true rather than hoped-for. It is NOT held by ordinary
    // statements, which are individually atomic and need no serialisation.
    const txGate = Semaphore.makeUnsafe(1);

    const bind = (params?: ReadonlyArray<SidecarParam>): SidecarValue[] =>
        (params ?? []).map(toBindable);

    const raw: JudgmentService["raw"] = (sql, params) =>
        Effect.try({
            try: () => db.query(sql).all(...bind(params)) as ReadonlyArray<SidecarRow>,
            catch: (err) =>
                new SidecarQueryError({ sql: sqlExcerpt(sql), message: errorMessage(err) }),
        });

    const exec: JudgmentService["exec"] = (sql, params) =>
        Effect.try({
            try: () => db.query(sql).run(...bind(params)).changes,
            catch: (err) =>
                new SidecarQueryError({ sql: sqlExcerpt(sql), message: errorMessage(err) }),
        });

    const rows: JudgmentService["rows"] = <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<SidecarParam>,
    ) =>
        raw(sql, params).pipe(
            Effect.flatMap((all) =>
                Schema.decodeUnknownEffect(Schema.Array(schema))(all).pipe(
                    Effect.mapError(
                        (issue) =>
                            new SidecarDecodeError({ sql: sqlExcerpt(sql), message: String(issue) }),
                    ),
                ),
            ),
        ) as Effect.Effect<ReadonlyArray<S["Type"]>, JudgmentError, S["DecodingServices"]>;

    const first = <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<SidecarParam>,
    ): Effect.Effect<Option.Option<S["Type"]>, JudgmentError, S["DecodingServices"]> =>
        Effect.map(rows(schema, sql, params), (all) =>
            all.length === 0 ? Option.none<S["Type"]>() : Option.some(all[0]!),
        );

    /**
     * One upsert covering `rows`, all of which must share `columns`.
     *
     * The conflict target is stated EXPLICITLY as `id`, exactly as the cache
     * seam does and for the same two reasons: several of these tables carry a
     * secondary unique index on top of the primary key (`proposal_dedupe_uq`,
     * `retro_session_uq`, `experiment_proposal_uq`, ...), and a row that
     * collides on such a NATURAL key while carrying a different id is a
     * constraint violation the caller should SEE, not a silent overwrite of a
     * different decision. `id TEXT PRIMARY KEY` on every table is a schema-wide
     * invariant, so a row without one is refused rather than inserted
     * un-upsertably.
     */
    const insertStatement = (
        table: string,
        columns: ReadonlyArray<string>,
        rowCount: number,
    ): Effect.Effect<string, SidecarQueryError> =>
        Effect.gen(function* () {
            const quotedTable = yield* quoteIdentifier("table", table);
            const quotedColumns: string[] = [];
            for (const column of columns) quotedColumns.push(yield* quoteIdentifier("column", column));

            const placeholders = `(${columns.map(() => "?").join(", ")})`;
            const updates = quotedColumns
                .filter((column) => column !== '"id"')
                .map((column) => `${column} = excluded.${column}`);
            // A row that is nothing but its id has no column left to update, and
            // `DO UPDATE SET` with an empty list is a syntax error.
            const onConflict =
                updates.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${updates.join(", ")}`;

            return `INSERT INTO ${quotedTable} (${quotedColumns.join(", ")}) VALUES ${Array.from(
                { length: rowCount },
                () => placeholders,
            ).join(", ")} ON CONFLICT ("id") ${onConflict}`;
        });

    const putMany: JudgmentService["putMany"] = (table, rowsIn) =>
        Effect.gen(function* () {
            if (rowsIn.length === 0) return;

            const columns = Object.keys(rowsIn[0]!);
            if (!columns.includes("id")) {
                return yield* new SidecarQueryError({
                    sql: `INSERT INTO ${table}`,
                    message:
                        `putMany into ${table} needs an \`id\` on every row: every table in the judgment schema is ` +
                        "keyed by `id TEXT PRIMARY KEY`, and the upsert names it as the conflict target. Rows given " +
                        `were missing it, so re-recording the same decision would append a duplicate instead of ` +
                        `replacing it. Got [${columns.join(", ")}].`,
                });
            }
            const signature = [...columns].sort().join(",");
            for (let i = 1; i < rowsIn.length; i += 1) {
                const other = [...Object.keys(rowsIn[i]!)].sort().join(",");
                if (other !== signature) {
                    return yield* new SidecarQueryError({
                        sql: `INSERT INTO ${table}`,
                        message:
                            `putMany requires every row to have the same columns, but row ${i} has [${other}] ` +
                            `while row 0 has [${signature}]. Split them into separate putMany calls - a ragged ` +
                            "batch would silently write NULLs into the columns a row omitted.",
                    });
                }
            }

            for (let start = 0; start < rowsIn.length; start += PUT_BATCH_ROWS) {
                const batch = rowsIn.slice(start, start + PUT_BATCH_ROWS);
                const sql = yield* insertStatement(table, columns, batch.length);
                const params = batch.flatMap((row) => columns.map((column) => row[column]!));
                yield* exec(sql, params);
            }
        });

    const put: JudgmentService["put"] = (table, row) => putMany(table, [row]);

    /**
     * `BEGIN IMMEDIATE`, not a bare `BEGIN`.
     *
     * A bare `BEGIN` starts DEFERRED: SQLite takes no write lock until the first
     * write statement, so a transaction that READS and then WRITES has to UPGRADE
     * its lock mid-flight. If another connection wrote in between, that upgrade
     * fails with SQLITE_BUSY and - crucially - `busy_timeout` does NOT apply to
     * it, because waiting could deadlock. Every interesting judgment transaction
     * has exactly that read-then-write shape (`ax improve accept` reads the
     * proposal, then writes the experiment). IMMEDIATE takes the write lock up
     * front, where `busy_timeout` DOES apply, so contention costs a wait instead
     * of an error.
     *
     * Rollback runs on interruption as well as on failure (`onExit`, not
     * `onError`): an interrupted fiber that left a transaction open would hold
     * the write lock until the process exited.
     */
    const transaction: JudgmentService["transaction"] = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        txGate.withPermits(1)(
            Effect.acquireUseRelease(
                exec("BEGIN IMMEDIATE"),
                () => body,
                (_, exit) => Effect.ignore(exec(exit._tag === "Success" ? "COMMIT" : "ROLLBACK")),
            ),
        ) as Effect.Effect<A, E | JudgmentError, R>;

    return { rows, first, raw, exec, put, putMany, transaction, path };
};

/**
 * A `Judgment` over the sidecar at `options.sidecarPath`.
 *
 * NOTHING is opened at layer-build time, for the same reason `CacheReadLayer`
 * opens nothing: `ax serve` and `ax mcp` build their layers at startup, and a
 * daemon that failed to build a layer because `~/.ax` did not exist yet would be
 * dead for the rest of its life. The first statement opens the database, creates
 * the directory if needed, applies the DDL and remembers the handle. A FAILURE is
 * deliberately not remembered.
 */
export const JudgmentLayer = (options: JudgmentLayerOptions): Layer.Layer<Judgment> =>
    Layer.effect(Judgment)(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = options.sidecarPath ?? sidecarPath();
            const schemaSql = options.schemaSql;
            const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

            let opened: JudgmentService | null = null;
            let handle: Database | null = null;
            // One permit, so a burst of concurrent first-statements opens the
            // database ONCE instead of racing N opens.
            const gate = Semaphore.makeUnsafe(1);

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    handle?.close();
                    handle = null;
                    opened = null;
                }),
            );

            const openOnce: Effect.Effect<JudgmentService, SidecarUnavailableError> = Effect.suspend(() =>
                opened !== null
                    ? Effect.succeed(opened)
                    : gate.withPermits(1)(
                          Effect.gen(function* () {
                              if (opened !== null) return opened;
                              const dir = posixPath.dirname(path);
                              yield* fs.makeDirectory(dir, { recursive: true }).pipe(
                                  Effect.mapError(
                                      (err) =>
                                          new SidecarUnavailableError({
                                              path,
                                              message: `could not create the ax judgment directory at ${dir}: ${errorMessage(err)}`,
                                          }),
                                  ),
                              );
                              const db = yield* Effect.try({
                                  try: () => {
                                      const database = new Database(path, { create: true });
                                      // WAL first: `journal_mode` is persistent
                                      // in the FILE, so this is a no-op after the
                                      // first ever open, and it is what lets the
                                      // daemon read while the CLI writes.
                                      database.exec("PRAGMA journal_mode = WAL");
                                      database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
                                      // NORMAL is the documented companion of WAL:
                                      // a commit is durable across a process
                                      // crash, and can lose only the last commits
                                      // in a power loss. The sidecar is a local
                                      // decision log, not a ledger; FULL would
                                      // fsync on every judgment write.
                                      database.exec("PRAGMA synchronous = NORMAL");
                                      if (schemaSql !== null) database.exec(schemaSql);
                                      return database;
                                  },
                                  catch: (err) =>
                                      new SidecarUnavailableError({
                                          path,
                                          message: `could not open the ax judgment sidecar at ${path}: ${errorMessage(err)}`,
                                      }),
                              });
                              handle = db;
                              opened = serviceOver(db, path);
                              return opened;
                          }),
                      ),
            );

            // The service is a thin forwarder onto the lazily-opened one. Each
            // method re-resolves through `openOnce`, which is a memo hit after
            // the first statement.
            const rows: JudgmentService["rows"] = (schema, sql, params) =>
                Effect.flatMap(openOnce, (s) => s.rows(schema, sql, params));
            const first: JudgmentService["first"] = (schema, sql, params) =>
                Effect.flatMap(openOnce, (s) => s.first(schema, sql, params));
            const raw: JudgmentService["raw"] = (sql, params) =>
                Effect.flatMap(openOnce, (s) => s.raw(sql, params));
            const exec: JudgmentService["exec"] = (sql, params) =>
                Effect.flatMap(openOnce, (s) => s.exec(sql, params));
            const put: JudgmentService["put"] = (table, row) =>
                Effect.flatMap(openOnce, (s) => s.put(table, row));
            const putMany: JudgmentService["putMany"] = (table, rowsIn) =>
                Effect.flatMap(openOnce, (s) => s.putMany(table, rowsIn));
            const transaction: JudgmentService["transaction"] = (body) =>
                Effect.flatMap(openOnce, (s) => s.transaction(body));

            return { rows, first, raw, exec, put, putMany, transaction, path };
        }),
    ).pipe(Layer.provide(BunFileSystem.layer));
