import {
    Surreal,
    RecordId,
    surql,
    type AnyRecordId,
    type ConnectOptions,
    type Table,
} from "surrealdb";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schedule } from "effect";
import { posixPath } from "@ax/lib/shared/path";
import { AxConfig, type AxConfigShape } from "./config.ts";
import { DbError } from "./errors.ts";

export type DbConfig = AxConfigShape["db"];

/**
 * Plain-string variant of {@link DbConfig} for non-Effect callers
 * (`scripts/*`): same env vars + defaults as `AxConfig.db`, but `pass` stays a
 * raw string so it can be fed straight to `db.signin`.
 */
export interface DbEnvConfig {
    readonly url: string;
    readonly ns: string;
    readonly db: string;
    readonly user: string;
    readonly pass: string;
}

/** Config recipe behind {@link envConfig}. Exported for hermetic tests
 *  (`dbEnvConfig.parse(ConfigProvider.fromEnv({ env }))`). */
export const dbEnvConfig: Config.Config<DbEnvConfig> = Config.all({
    url: Config.string("AX_DB_URL").pipe(Config.withDefault("ws://127.0.0.1:8521")),
    ns: Config.string("AX_DB_NS").pipe(Config.withDefault("ax")),
    db: Config.string("AX_DB_DB").pipe(Config.withDefault("main")),
    user: Config.string("AX_DB_USER").pipe(Config.withDefault("root")),
    pass: Config.string("AX_DB_PASS").pipe(Config.withDefault("root")),
});

/** Back-compat: read DB knobs straight from env. Prefer the AxConfig service. */
export function envConfig(): DbEnvConfig {
    // Fresh provider per call so process.env is read at call time, exactly
    // like the previous direct reads. fromEnv loads synchronously.
    return Effect.runSync(dbEnvConfig.parse(ConfigProvider.fromEnv()));
}

const sqlExcerpt = (sql: unknown): string | undefined => {
    if (typeof sql !== "string") return undefined;
    return sql.length > 200 ? `${sql.slice(0, 200)}…` : sql;
};

const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

/** Connect timeout for the initial SurrealDB handshake. Bun's WebSocket has
 *  no built-in timeout on hung daemons, so we cap acquisition at 5s. */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * Detects "Transaction conflict" errors from SurrealDB's optimistic-locking
 * layer. Concurrent writers (e.g. two `axctl ingest` runs hitting the same
 * rocksdb keys) hit this and SurrealDB explicitly tells us we can retry.
 *
 * Examples of matching messages:
 *   - "Transaction conflict: this transaction can be retried"
 *   - "transaction failed, can be retried"
 */
const isTransactionConflict = (err: DbError): boolean =>
    /transaction conflict|can be retried/i.test(err.message);

/**
 * Retry policy for transient transaction conflicts: jittered exponential
 * backoff (~100ms, 200ms, 400ms, 800ms, 1.6s, 3.2s ±20%) capped at 6 retries.
 * Only retries while the error looks like a transaction conflict - any other
 * DbError fails fast.
 *
 * The jitter is the important part: two ingest processes (e.g. the background
 * watcher + a manual `axctl ingest` run) hitting the same hot record
 * (agent_provider:`codex`, sessions, etc.) back off in LOCKSTEP without it, so
 * they collide again on every retry and exhaust the budget. Jittering the
 * delays de-correlates the retriers so one wins and the other settles.
 */
const transactionConflictRetry = Schedule.exponential("100 millis", 2).pipe(
    Schedule.jittered,
    Schedule.take(6),
    Schedule.while<DbError, unknown>((metadata) => isTransactionConflict(metadata.input)),
    Schedule.tapInput((err: DbError) =>
        Effect.logDebug("db transaction conflict retry", {
            operation: err.operation,
            message: err.message,
            sql: err.sql,
        }),
    ),
);

/**
 * Effect-friendly wrapper around the SurrealDB client. Acquired as a Layer so
 * the underlying connection lifecycle (connect/signin/use → close) is tied to
 * the surrounding scope.
 */
export interface SurrealClientShape {
    /** Run a raw SurrealQL statement. Returns the array result tuple as-is. */
    readonly query: <T extends unknown[] = unknown[]>(
        sql: string,
        bindings?: Record<string, unknown>,
    ) => Effect.Effect<T, DbError>;

    /** Upsert a record by id with the given content. */
    readonly upsert: (
        id: RecordId,
        content: Record<string, unknown>,
    ) => Effect.Effect<unknown, DbError>;

    /** Relate two records via an edge table. */
    readonly relate: (
        from: AnyRecordId,
        edge: Table | RecordId,
        to: AnyRecordId,
        data?: Record<string, unknown>,
    ) => Effect.Effect<unknown, DbError>;

    /**
     * Write content to a SurrealDB v3 file bucket. Path is relative within the
     * bucket (e.g. `<session-id>.jsonl`). Uses SurrealQL `f"bucket:/path".put($c)`
     * syntax under the hood. Requires `--allow-experimental files`.
     */
    readonly putFile: (
        bucket: string,
        path: string,
        content: string | Uint8Array,
    ) => Effect.Effect<void, DbError>;

    /**
     * Read content from a SurrealDB v3 file bucket as a UTF-8 string. Uses
     * SurrealQL `<string>f"bucket:/path".get()`.
     */
    readonly getFile: (
        bucket: string,
        path: string,
    ) => Effect.Effect<string, DbError>;

    /** Escape hatch for the raw client when callers need methods we don't wrap. */
    readonly raw: Surreal;
}

/**
 * Format a stored file-pointer string for record fields. We persist the bare
 * `bucket:/path` form (without the SurrealQL `f"..."` literal wrapper) so
 * downstream code can split on `:/` without parsing.
 */
export const filePointer = (bucket: string, path: string): string =>
    `${bucket}:/${path}`;

export class SurrealClient extends Context.Service<
    SurrealClient,
    SurrealClientShape
>()("ax/SurrealClient") {}

const connectError = (url: string, reason: string): DbError =>
    new DbError({
        operation: "connect",
        message: `daemon not reachable at ${url} (${reason}); recover with 'axctl daemon start' (or 'axctl daemon restart'); 'axctl doctor' shows where it stalled`,
    });

/**
 * Build the {@link ConnectOptions} for a long-lived SurrealDB connection.
 *
 * Critically, credentials + ns/db are passed to `connect()` rather than applied
 * after the fact via `signin()`/`use()`. This is what keeps a long-running
 * daemon connection authenticated across the connection's whole life:
 *
 *  - The SDK stores `authentication` as its internal auth *provider*. On every
 *    (re)connect AND on the token-expiry renewal timer it replays the provider
 *    (`#applyAuthProvider` -> `signin(..., skipOverride=true)`), so the session
 *    is re-signed-in instead of silently falling back to anonymous.
 *  - `namespace`/`database` are stored on the root session and replayed via
 *    `use()` on every reconnect (`#restoreSession`).
 *
 * By contrast, calling the public `db.signin()` sets `authOverriden = true`,
 * which *disables* the auth provider on renewal. The root JWT issued by signin
 * has a finite TTL and no refresh token, so once it expires the SDK's renewal
 * logic finds nothing to renew with and invalidates the session -> every
 * subsequent query returns "Anonymous access not allowed". That is the
 * recurring `ax serve` auth-loss bug (#431); routing auth through `connect()`
 * fixes it for both the reconnect and the token-expiry path.
 *
 * Exported for hermetic unit tests (assert credentials are wired so the SDK's
 * re-auth path stays live).
 */
export const connectOptions = (cfg: DbConfig): ConnectOptions => ({
    namespace: cfg.ns,
    database: cfg.db,
    authentication: {
        username: cfg.user,
        password: Redacted.value(cfg.pass),
    },
    // Explicit even though the SDK default is true: the WS engine must
    // auto-reconnect a dropped daemon connection, and on reconnect the auth
    // provider above re-signs-in (see #restoreSession / #applyAuthentication).
    reconnect: true,
});

/** Minimal slice of the Surreal client `acquire` depends on. Lets tests inject
 *  a fake that records the connect options without a live daemon. */
export interface SurrealLike {
    connect(url: string, options?: ConnectOptions): Promise<unknown>;
    close(): Promise<unknown>;
}

/** Factory for the underlying client. Overridable in tests. */
export type SurrealFactory = () => SurrealLike;

const defaultSurrealFactory: SurrealFactory = () => new Surreal();

export const acquire = (
    cfg: DbConfig,
    createClient: SurrealFactory = defaultSurrealFactory,
): Effect.Effect<Surreal, DbError> =>
    Effect.tryPromise({
        try: async () => {
            const db = createClient();
            // Auth + ns/db travel with connect() so the SDK re-applies them on
            // every reconnect and token renewal (see connectOptions docs).
            await db.connect(cfg.url, connectOptions(cfg));
            return db as Surreal;
        },
        catch: (err) => connectError(cfg.url, errorMessage(err)),
    }).pipe(
        // Bun's WebSocket has no implicit timeout - if the daemon is down,
        // `db.connect()` hangs forever. Cap acquisition at 5s and surface a
        // typed DbError with a clear hint so the CLI doesn't appear frozen.
        Effect.timeoutOrElse({
            duration: `${CONNECT_TIMEOUT_MS} millis`,
            orElse: () =>
                Effect.fail(
                    connectError(
                        cfg.url,
                        `connect timed out after ${CONNECT_TIMEOUT_MS}ms`,
                    ),
                ),
        }),
    );

const release = (db: Surreal): Effect.Effect<void> =>
    Effect.promise(async () => {
        try {
            await db.close();
        } catch {
            // best effort
        }
    });

// Debug seam (AX_DB_QUERY_LOG=<path>): append a line before and after every
// db.query() so a wedged statement is identifiable post-mortem - the last
// "start" without a matching "done" is the in-flight SQL. A single buffered
// Bun FileSink (flushed per line) keeps ordering exact without node:fs; the
// env gate keeps production paths allocation-free. The gate is read once at
// layer build via Config (see `queryLogConfig`).
interface QueryLogState {
    readonly path: string;
    /** AX_DB_QUERY_LOG_FULL=1: also write one full-statement file per query. */
    readonly full: boolean;
}

/**
 * Keep shorthand/flag-like values out of the caller's cwd. Explicit paths
 * retain their existing meaning; bare names are made recognizable and routed
 * under ax's data directory.
 */
export const resolveQueryLogPath = (
    value: string,
    dataDir: string,
    cwd: string,
): string => {
    if (value.includes("/")) return value;
    const resolvedDataDir = posixPath.resolve(cwd, dataDir);
    return posixPath.join(
        resolvedDataDir,
        `db-query-${encodeURIComponent(value)}.querylog`,
    );
};

const queryLogConfig = (
    dataDir: string,
): Effect.Effect<QueryLogState | undefined> => Effect.gen(function* () {
        const path = Option.getOrUndefined(
            yield* Config.string("AX_DB_QUERY_LOG").pipe(Config.option),
        );
        if (path === undefined || path.length === 0) return undefined;
        const full = Option.getOrUndefined(
            yield* Config.string("AX_DB_QUERY_LOG_FULL").pipe(Config.option),
        );
        return {
            path: resolveQueryLogPath(path, dataDir, process.cwd()),
            full: full === "1",
        };
    }).pipe(Effect.orDie);

let queryLogSeq = 0;
let queryLogSink: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
const logQuery = (
    log: QueryLogState,
    phase: "start" | "done",
    seq: number,
    ms: number,
    sql?: string,
): void => {
    try {
        queryLogSink ??= Bun.file(log.path).writer();
        queryLogSink.write(
            `${new Date().toISOString()} q${seq} ${phase}${phase === "done" ? ` +${ms.toFixed(0)}ms` : ""}${sql === undefined ? "" : ` ${sql.slice(0, 300).replaceAll("\n", " ")}`}\n`,
        );
        void queryLogSink.flush();
        // Full-statement capture for replay: one file per query start.
        if (phase === "start" && sql !== undefined && log.full) {
            void Bun.write(`${log.path}.q${seq}.sql`, sql);
        }
    } catch {
        // diagnostics only - never fail the query path
    }
};

const wrap = (db: Surreal, queryLog?: QueryLogState): SurrealClientShape => ({
    query: <T extends unknown[] = unknown[]>(
        sql: string,
        bindings?: Record<string, unknown>,
    ) =>
        Effect.tryPromise({
            try: async () => {
                if (!queryLog) return await (db.query<T>(sql, bindings) as Promise<T>);
                const seq = ++queryLogSeq;
                const t0 = performance.now();
                logQuery(queryLog, "start", seq, 0, sql);
                const out = await (db.query<T>(sql, bindings) as Promise<T>);
                logQuery(queryLog, "done", seq, performance.now() - t0);
                return out;
            },
            catch: (err) =>
                new DbError({
                    operation: "query",
                    message: errorMessage(err),
                    sql: sqlExcerpt(sql),
                }),
        }).pipe(Effect.retry(transactionConflictRetry)),

    upsert: (id: RecordId, content: Record<string, unknown>) =>
        Effect.tryPromise({
            try: () => db.upsert(id).content(content) as unknown as Promise<unknown>,
            catch: (err) =>
                new DbError({
                    operation: "upsert",
                    message: errorMessage(err),
                    sql: id.toString(),
                }),
        }).pipe(Effect.retry(transactionConflictRetry)),

    relate: (
        from: AnyRecordId,
        edge: Table | RecordId,
        to: AnyRecordId,
        data?: Record<string, unknown>,
    ) =>
        Effect.tryPromise({
            try: () =>
                (data === undefined
                    ? db.relate(from, edge, to)
                    : db.relate(from, edge, to, data)) as unknown as Promise<unknown>,
            catch: (err) =>
                new DbError({
                    operation: "relate",
                    message: errorMessage(err),
                }),
        }).pipe(Effect.retry(transactionConflictRetry)),

    putFile: (bucket: string, path: string, content: string | Uint8Array) =>
        Effect.tryPromise({
            try: async () => {
                // SurrealQL: f"<bucket>:/<path>".put($content)
                // Bucket + path are interpolated (validated by caller); content
                // is parameterized to handle binary + arbitrary text safely.
                const sql = `f"${bucket}:/${path}".put($content); RETURN true;`;
                await db.query(sql, { content });
            },
            catch: (err) =>
                new DbError({
                    operation: "putFile",
                    message: errorMessage(err),
                    sql: `${bucket}:/${path}`,
                }),
        }).pipe(Effect.retry(transactionConflictRetry)),

    getFile: (bucket: string, path: string) =>
        Effect.tryPromise({
            try: async () => {
                // <string> cast forces bytes -> UTF-8 string per SurrealDB 3.0 docs.
                const sql = `RETURN <string>f"${bucket}:/${path}".get();`;
                const result = (await db.query(sql)) as unknown[];
                const first = result?.[0];
                return typeof first === "string" ? first : String(first ?? "");
            },
            catch: (err) =>
                new DbError({
                    operation: "getFile",
                    message: errorMessage(err),
                    sql: `${bucket}:/${path}`,
                }),
        }).pipe(Effect.retry(transactionConflictRetry)),

    raw: db,
});

/**
 * Layer that connects to SurrealDB on acquisition, exposes a `SurrealClient`
 * service, and closes the underlying connection on scope close.
 */
export const SurrealClientLive: Layer.Layer<SurrealClient, DbError, AxConfig> =
    Layer.effect(SurrealClient)(
        Effect.gen(function* () {
            const cfg = yield* AxConfig;
            const queryLog = yield* queryLogConfig(cfg.paths.dataDir);
            const db = yield* Effect.acquireRelease(acquire(cfg.db), release);
            return wrap(db, queryLog);
        }),
    );

export { RecordId, surql };
