import {
    Surreal,
    RecordId,
    surql,
    type AnyRecordId,
    type Table,
} from "surrealdb";
import { Context, Effect, Layer, Schedule } from "effect";
import { DbError } from "./errors.ts";

export interface DbConfig {
    url: string;
    ns: string;
    db: string;
    user: string;
    pass: string;
}

export function envConfig(): DbConfig {
    return {
        url: process.env.AGENTCTL_DB_URL ?? "ws://127.0.0.1:8521",
        ns: process.env.AGENTCTL_DB_NS ?? "agentctl",
        db: process.env.AGENTCTL_DB_DB ?? "main",
        user: process.env.AGENTCTL_DB_USER ?? "root",
        pass: process.env.AGENTCTL_DB_PASS ?? "root",
    };
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
 * layer. Concurrent writers (e.g. two `agentctl ingest` runs hitting the same
 * rocksdb keys) hit this and SurrealDB explicitly tells us we can retry.
 *
 * Examples of matching messages:
 *   - "Transaction conflict: this transaction can be retried"
 *   - "transaction failed, can be retried"
 */
const isTransactionConflict = (err: DbError): boolean =>
    /transaction conflict|can be retried/i.test(err.message);

/**
 * Retry policy for transient transaction conflicts: exponential backoff
 * (100ms, 200ms, 400ms) capped at 3 retries. Only retries while the error
 * looks like a transaction conflict - any other DbError fails fast.
 */
const transactionConflictRetry = Schedule.exponential("100 millis", 2).pipe(
    Schedule.take(3),
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
>()("agentctl/SurrealClient") {}

const connectError = (url: string, reason: string): DbError =>
    new DbError({
        operation: "connect",
        message: `daemon not reachable at ${url} (${reason}); run 'agentctl install' to start it`,
    });

const acquire = (cfg: DbConfig): Effect.Effect<Surreal, DbError> =>
    Effect.tryPromise({
        try: async () => {
            const db = new Surreal();
            await db.connect(cfg.url);
            await db.signin({ username: cfg.user, password: cfg.pass });
            await db.use({ namespace: cfg.ns, database: cfg.db });
            return db;
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

const wrap = (db: Surreal): SurrealClientShape => ({
    query: <T extends unknown[] = unknown[]>(
        sql: string,
        bindings?: Record<string, unknown>,
    ) =>
        Effect.tryPromise({
            try: () => db.query<T>(sql, bindings) as Promise<T>,
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
        }),

    raw: db,
});

/**
 * Layer that connects to SurrealDB on acquisition, exposes a `SurrealClient`
 * service, and closes the underlying connection on scope close.
 */
export const SurrealClientLive: Layer.Layer<SurrealClient, DbError> =
    Layer.effect(SurrealClient)(
        Effect.gen(function* () {
            const cfg = envConfig();
            const db = yield* Effect.acquireRelease(acquire(cfg), release);
            return wrap(db);
        }),
    );

export { RecordId, surql };
