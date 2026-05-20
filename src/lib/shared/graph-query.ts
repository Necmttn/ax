/**
 * graph-query: typed helpers for SurrealDB read resolvers.
 *
 * Dashboard read paths kept restating the same skeleton:
 *
 *   Effect.gen(function* () {
 *     const db = yield* SurrealClient;
 *     const rid = toSessionRid(toBareSessionId(id));
 *     const [rows] = yield* db.query<[Row[]]>(`... ${rid} ...`);
 *     return mapRowsToX(rows);
 *   }).pipe(Effect.catch(err => Effect.sync(() => {
 *     console.error("axctl X failed:", err);
 *     return defaultX;
 *   })));
 *
 * Each helper here collapses that skeleton to a single call. The SQL + row
 * mapper become the *only* interesting bits in the resolver - everything else
 * (record-id interpolation, defensive DB-error recovery, observability) is
 * centralised so the policy is consistent across every dashboard read.
 *
 * ## Error policy
 *
 * `queryOptional` and `queryMany` are **defensive**: any DB failure logs the
 * caller-supplied `context` string and returns the safe default (`null` /
 * `[]`). The resulting Effect's error channel is `never`. This matches the
 * existing dashboard pattern: read-only metadata that's decorative for the UI
 * should degrade silently rather than fail the whole page.
 *
 * `queryPagedWithCount` keeps the typed DbError channel - its callers
 * (sessions-list, recall) propagate errors today, and we don't want to silently
 * paper over count drift in a paginated view. If a defensive page+count
 * variant becomes useful later, add it explicitly.
 *
 * Mapper exceptions are NOT caught. Those are programmer errors (bad row
 * shape, missing field) and should surface during dev rather than degrade to
 * an empty default.
 *
 * ## Record-id interpolation
 *
 * SurrealDB record-id parameter bindings have shaky support for our `session:`
 * prefix form in this project (see the long-standing comments in
 * session-detail.ts about silent empty results from `new RecordId(...)`
 * bindings). Until that's resolved we keep the template-literal splice but
 * funnel it through `interpolateRid` so the seam is named, searchable, and
 * uses the validated `toSessionRid` output. Non-RID bindings (strings,
 * numbers, ISO timestamps) still go through the SDK's `$param` bindings.
 */

import { Effect } from "effect";
import { SurrealClient } from "../db.ts";
import type { DbError } from "../errors.ts";
import { toSessionRid, type SessionId } from "./session-id.ts";
import type { Query, SingleQuery } from "../../queries/query.ts";

/** Single-row select. Maps to `T | null` and swallows DB errors to `null`.
 *  Use for "fetch this thing for this session if it exists". */
export const queryOptional = <Row, T>(
    sql: string,
    mapRow: (row: Row) => T,
    context: string,
    bindings?: Record<string, unknown>,
): Effect.Effect<T | null, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[Row[]]>(sql, bindings);
        const row = rows?.[0];
        return row === undefined ? null : mapRow(row);
    }).pipe(
        Effect.catch((err: DbError) =>
            Effect.sync(() => {
                console.error(`axctl ${context} failed:`, err);
                return null as T | null;
            }),
        ),
    );

/** Multi-row select. Maps each row, returns the array; DB errors degrade to
 *  `[]`. Use for "fetch the X collection for this session". */
export const queryMany = <Row, T>(
    sql: string,
    mapRow: (row: Row, index: number) => T,
    context: string,
    bindings?: Record<string, unknown>,
): Effect.Effect<ReadonlyArray<T>, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[Row[]]>(sql, bindings);
        return (rows ?? []).map((row, idx) => mapRow(row, idx));
    }).pipe(
        Effect.catch((err: DbError) =>
            Effect.sync(() => {
                console.error(`axctl ${context} failed:`, err);
                return [] as ReadonlyArray<T>;
            }),
        ),
    );

/** Paged result + total count, returned as a structured object. Encapsulates
 *  the multi-statement `SELECT ... START $offset LIMIT $limit; SELECT count()
 *  ... GROUP ALL;` pattern that sessions-list and recall both use.
 *
 *  Unlike the defensive helpers above, this one propagates DbError - the
 *  pagination callers want the failure visible at the HTTP boundary so the
 *  SPA can surface a real error instead of silently rendering "0 results". */
export interface PagedResult<T> {
    readonly items: ReadonlyArray<T>;
    readonly total: number;
}

export const queryPagedWithCount = <PageRow, CountRow, T>(
    sql: string,
    mapPageRow: (row: PageRow) => T,
    readCount: (row: CountRow) => number,
    bindings?: Record<string, unknown>,
): Effect.Effect<PagedResult<T>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [pageRows, countRows] = yield* db.query<[PageRow[], CountRow[]]>(
            sql,
            bindings,
        );
        const items = (pageRows ?? []).map(mapPageRow);
        const countRow = countRows?.[0];
        const totalRaw = countRow === undefined ? 0 : Number(readCount(countRow) ?? 0);
        const total = Number.isFinite(totalRaw) ? Math.trunc(totalRaw) : 0;
        return { items, total };
    });

/**
 * Splice a validated session record-id into a SurrealQL template at every
 * occurrence of the named placeholder. We bypass SDK bindings for record ids
 * because `db.query(sql, { sid: new RecordId(...) })` has produced empty
 * results historically in this codebase (see session-detail.ts comments).
 *
 * Placeholder convention is `$<name>` (e.g. `$sid`). The replacement is the
 * `toSessionRid(...)` output which is escape-safe by construction: it strips
 * backticks defensively and wraps in `` `...` `` when the id isn't unquoted-
 * safe. So the substitution is injection-safe for any SessionId that has
 * already crossed the wire seam.
 *
 * Use only for record-id splicing. Pass strings, numbers, dates etc. via the
 * SDK's `bindings` arg.
 */
/**
 * Execute a {@link Query}: build SQL + bindings from params, run, map rows.
 * Defensive - a DB failure logs `query.name` and degrades to `[]`, matching
 * the `queryMany` policy. Mapper exceptions are NOT caught.
 */
export const runQuery = <Params, Row, T>(
    query: Query<Params, Row, T>,
    params: Params,
): Effect.Effect<ReadonlyArray<T>, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[Row[]]>(
            query.sql(params),
            query.bindings?.(params),
        );
        return (rows ?? []).map((row, i) => query.mapRow(row, i));
    }).pipe(
        Effect.catch((err: DbError) =>
            Effect.sync(() => {
                console.error(`axctl ${query.name} failed:`, err);
                return [] as ReadonlyArray<T>;
            }),
        ),
    );

/**
 * Execute a {@link SingleQuery}: returns the mapped first row or `null`.
 * Same defensive policy as {@link runQuery}.
 */
export const runSingleQuery = <Params, Row, T>(
    query: SingleQuery<Params, Row, T>,
    params: Params,
): Effect.Effect<T | null, never, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[Row[]]>(
            query.sql(params),
            query.bindings?.(params),
        );
        const row = rows?.[0];
        return row === undefined ? null : query.mapRow(row, 0);
    }).pipe(
        Effect.catch((err: DbError) =>
            Effect.sync(() => {
                console.error(`axctl ${query.name} failed:`, err);
                return null as T | null;
            }),
        ),
    );

export const interpolateRid = (
    sql: string,
    sessionId: SessionId,
    placeholder = "$sid",
): string => sql.split(placeholder).join(toSessionRid(sessionId));
