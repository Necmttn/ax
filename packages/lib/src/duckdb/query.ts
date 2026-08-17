/**
 * The typed read helpers every reader goes through.
 *
 * One module holds both halves of a read: the query as a value ({@link Clause}
 * holding the parameters, `Schema` holding the row contract) and running one
 * (resolve the cache, map the rows, apply the error policy below). Row ids are
 * plain VARCHARs, so a record id is a bound parameter like every other value -
 * there is no id-splicing seam here, and so no injection surface from one.
 *
 * ## Error policy
 *
 * {@link cacheRows} / {@link cacheFirst} / {@link runCacheQuery} /
 * {@link runCacheSingleQuery} are DEFENSIVE: any read failure logs the caller's
 * context and degrades to `[]` / `null`, so their error channel is `never`.
 * That is the policy the ~95 dashboard, CLI and MCP read sites are written
 * against - decorative, read-only metadata should degrade rather than fail a
 * whole page.
 *
 * {@link cachePaged} keeps its typed error channel instead: a paginated view
 * that degrades silently renders "0 results", which a user cannot tell apart
 * from a genuinely empty result set.
 *
 * A {@link CacheUnavailableError} - no snapshot published yet - is the single
 * most common cause of an empty read on a fresh install, and the seam already
 * composed the sentence that fixes it. So that case is logged as its own line
 * naming `ax ingest`, instead of being flattened into the same "query failed"
 * noise as a genuine bug.
 *
 * Mapper exceptions are NOT caught: a mapper that throws has a bad row shape,
 * which is a programmer error that should surface in development rather than
 * degrade to an empty list in production.
 */
import { Effect, Schema } from "effect";
import type { Clause } from "./clause.ts";
import { NumberFromBigIntColumn } from "./columns.ts";
import { CacheRead, type CacheReadError } from "./seam.ts";

/**
 * The `SELECT count(*) AS total` row, spelled once.
 *
 * `count(*)` comes back as a BIGINT, which decodes to a JS `bigint` - so a
 * caller that reaches for `Schema.Number` here gets a decode FAILURE, and
 * (under the defensive policy above) a silently empty result. Every ported
 * count query uses this instead of re-deriving it.
 */
export const CountRow = Schema.Struct({ total: NumberFromBigIntColumn });

/** Log a read failure once, in the shape the caller can act on. */
const reportFailure = (context: string, err: CacheReadError): void => {
    if (err._tag === "CacheUnavailableError") {
        console.error(`ax ${context}: ${err.message}`);
        return;
    }
    console.error(`ax ${context} failed:`, err);
};

/** Run a clause and decode every row. Failures propagate - this is the strict
 *  core the defensive helpers wrap, and what a caller that genuinely wants the
 *  error (an HTTP boundary, a CLI that must exit non-zero) uses directly. */
export const cacheRowsOrFail = <S extends Schema.Top>(
    schema: S,
    clause: Clause,
): Effect.Effect<ReadonlyArray<S["Type"]>, CacheReadError, CacheRead | S["DecodingServices"]> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        return yield* cache.rows(schema, clause.sql, clause.params);
    });

/** Multi-row read. A failure logs `context` and degrades to `[]`. */
export const cacheRows = <S extends Schema.Top>(
    schema: S,
    clause: Clause,
    context: string,
): Effect.Effect<ReadonlyArray<S["Type"]>, never, CacheRead | S["DecodingServices"]> =>
    cacheRowsOrFail(schema, clause).pipe(
        Effect.catch((err: CacheReadError) =>
            Effect.sync(() => {
                reportFailure(context, err);
                return [] as ReadonlyArray<S["Type"]>;
            }),
        ),
    );

/**
 * The first row, or `null`. A second row is not an error - callers that want
 * exactly one write `LIMIT 1`; this is about absence, not cardinality.
 *
 * `null` rather than `Option`, because that is what the ~40 call sites of the
 * module this replaces read, and the seam's own `first` already offers the
 * `Option` spelling for code that prefers it.
 */
export const cacheFirst = <S extends Schema.Top>(
    schema: S,
    clause: Clause,
    context: string,
): Effect.Effect<S["Type"] | null, never, CacheRead | S["DecodingServices"]> =>
    Effect.map(cacheRows(schema, clause, context), (rows) => rows[0] ?? null);

export interface PagedResult<T> {
    readonly items: ReadonlyArray<T>;
    readonly total: number;
}

/**
 * One page plus the total row count, as two statements.
 *
 * Two statements rather than a windowed `count(*) OVER ()`: the page query
 * carries `LIMIT`/`OFFSET` parameters the count must NOT have, and a window
 * function would compute the total for every returned row. The caller supplies
 * both clauses so the two can be built from the same filter set - the one thing
 * that must not drift, since a count that disagrees with the page produces
 * pagination that walks off the end of a result set.
 *
 * Unlike its siblings this PROPAGATES failures - see the module header.
 */
export const cachePaged = <S extends Schema.Top, T>(
    schema: S,
    page: Clause,
    count: Clause,
    mapRow: (row: S["Type"], index: number) => T,
): Effect.Effect<PagedResult<T>, CacheReadError, CacheRead | S["DecodingServices"]> =>
    Effect.gen(function* () {
        const cache = yield* CacheRead;
        const rows = yield* cache.rows(schema, page.sql, page.params);
        const counted = yield* cache.rows(CountRow, count.sql, count.params);
        return {
            items: rows.map((row, index) => mapRow(row, index)),
            total: counted[0]?.total ?? 0,
        };
    });

/**
 * A query as a VALUE: the name it is reported under, the row contract, how to
 * build the statement from its parameters, and how to map a decoded row to the
 * domain type.
 *
 * The point of naming it is that the defensive policy needs a label, and a
 * query definition carries one already - so a ported call site is
 * `runCacheQuery(theQuery, params)` with no context string to keep in sync.
 */
export interface CacheQuery<Params, S extends Schema.Top, T> {
    readonly name: string;
    readonly single?: false;
    readonly row: S;
    readonly clause: (params: Params) => Clause;
    readonly mapRow: (row: S["Type"], index: number) => T;
}

/** A single-row query - {@link runCacheSingleQuery} returns `T | null`. */
export interface CacheSingleQuery<Params, S extends Schema.Top, T>
    extends Omit<CacheQuery<Params, S, T>, "single"> {
    readonly single: true;
}

export const defineCacheQuery = <Params, S extends Schema.Top, T>(
    query: Omit<CacheQuery<Params, S, T>, "single">,
): CacheQuery<Params, S, T> => ({ ...query, single: false });

export const defineCacheSingleQuery = <Params, S extends Schema.Top, T>(
    query: Omit<CacheSingleQuery<Params, S, T>, "single">,
): CacheSingleQuery<Params, S, T> => ({ ...query, single: true });

/** Run a {@link CacheQuery}. Defensive: degrades to `[]`, reported under the
 *  query's own name. */
export const runCacheQuery = <Params, S extends Schema.Top, T>(
    query: CacheQuery<Params, S, T>,
    params: Params,
): Effect.Effect<ReadonlyArray<T>, never, CacheRead | S["DecodingServices"]> =>
    Effect.map(cacheRows(query.row, query.clause(params), query.name), (rows) =>
        rows.map((row, index) => query.mapRow(row, index)),
    );

/** Run a {@link CacheSingleQuery}. Defensive: degrades to `null`. */
export const runCacheSingleQuery = <Params, S extends Schema.Top, T>(
    query: CacheSingleQuery<Params, S, T>,
    params: Params,
): Effect.Effect<T | null, never, CacheRead | S["DecodingServices"]> =>
    Effect.map(cacheRows(query.row, query.clause(params), query.name), (rows) => {
        const row = rows[0];
        return row === undefined ? null : query.mapRow(row, 0);
    });
