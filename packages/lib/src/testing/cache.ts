/**
 * A `CacheRead` whose ROWS are canned but whose DECODE is real.
 *
 * WHY THE DECODE IS NOT OPTIONAL. The first version of this helper ignored the
 * schema entirely (`rows: (_schema, sql) => canned as never`). That made every
 * suite built on it blind to the single most common porting mistake in the
 * DuckDB migration: a column contract that does not match what the database
 * actually returns. `count(*)` comes back as a BIGINT and must decode as
 * `Schema.BigInt` / `NumberFromBigIntColumn`, never `Schema.Number`; arrays and
 * nested objects are JSON TEXT in a VARCHAR, not native LISTs; timestamps are
 * `Date`, not ISO strings. A fake that skips `Schema` cannot tell a working
 * query from one that merely looks right - which is exactly what the plan means
 * by "SQL-text assertions do not count as coverage".
 *
 * So this helper decodes through `Schema.decodeUnknownEffect` with the same
 * error mapping the real DuckDB client uses (`queryAs` in ../duckdb/client.ts),
 * and a row shape that does not satisfy the caller's contract fails the test
 * with a `DuckDbDecodeError` rather than sailing through as `never`.
 *
 * WHAT IT STILL CANNOT DO, and when to reach for the real thing instead. It does
 * not parse, plan or execute SQL, so it cannot catch a malformed statement, a
 * wrong JOIN, a missing `score IS NOT NULL` outside a BM25 subquery, or a
 * predicate that silently matches nothing. Route selection here is a substring
 * or regex match on the SQL TEXT, which is a test-fixture convenience, NOT
 * evidence the query is right.
 *
 * Use this for logic ABOVE the query - rollups, ranking, formatting, branching
 * on row counts - where seeding a real database would only obscure the case
 * under test. Anything that asserts a query RETURNS THE RIGHT ROWS belongs on a
 * real temp DuckDB via `duckdbTestSetup` + `publishCacheFixture`
 * (@ax/lib/testing/duckdb-dylib, ./cache-fixture.ts).
 */
import { Effect, Layer, Option, Schema } from "effect";
import { CacheRead, type CacheReadService } from "../duckdb/seam.ts";
import { DuckDbDecodeError } from "../duckdb/errors.ts";
import type { DuckDbParam } from "../duckdb/types.ts";

export type TestCacheRows = ReadonlyArray<unknown>;

export type TestCacheResponder =
    | TestCacheRows
    | ((sql: string, params: ReadonlyArray<DuckDbParam> | undefined) => TestCacheRows);

export interface TestCacheRoute {
    readonly match: string | RegExp;
    readonly rows: TestCacheResponder;
}

export interface TestCacheOptions {
    readonly routes?: ReadonlyArray<TestCacheRoute> | Readonly<Record<string, TestCacheResponder>>;
    readonly responses?: ReadonlyArray<TestCacheRows>;
    readonly fallback?: TestCacheResponder;
}

export interface TestCacheRead {
    readonly service: CacheReadService;
    readonly layer: Layer.Layer<CacheRead>;
    readonly captured: string[];
}

const routeList = (
    routes: TestCacheOptions["routes"],
): ReadonlyArray<TestCacheRoute> => Array.isArray(routes)
    ? routes as ReadonlyArray<TestCacheRoute>
    : Object.entries(routes ?? {}).map(([match, rows]) => ({ match, rows }));

const normalizeRows = (rows: TestCacheRows): TestCacheRows =>
    rows.length === 1 && Array.isArray(rows[0]) ? rows[0] : rows;

/**
 * Canned rows are written as JSON-ish literals, but DuckDB hands back `Date` for
 * a TIMESTAMP column. Convert the conventional timestamp column names so a
 * fixture can stay readable without every case restating `new Date(...)`; the
 * DECODE still has to accept the result, so this is a convenience, not a bypass.
 */
const isTimestampColumn = (key: string): boolean =>
    key === "ts" || key.endsWith("_ts") || key.endsWith("_at");

const asDuckDbRows = (rows: TestCacheRows): TestCacheRows => rows.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => {
        const timestamp = isTimestampColumn(key);
        return [key, timestamp && typeof value === "string" ? new Date(value) : value];
    }));
});

/** The first 200 characters of `sql`, for a decode failure's message. */
const sqlExcerpt = (sql: string): string =>
    sql.length <= 200 ? sql : `${sql.slice(0, 200)}...`;

/**
 * Give every column the caller's schema names a value, defaulting absent ones to
 * `null` - because that is what the database does. A DuckDB result row carries
 * EVERY selected column; a column with no value comes back NULL, never missing.
 * Fixtures, though, are written by hand and naturally omit the columns a case
 * does not care about, and without this a terse row fails as "Missing key" -
 * noise that corresponds to no real-world failure.
 *
 * This does NOT weaken the decode, which is the whole point of the helper:
 *   - a column typed `Schema.String` that fills in as `null` still fails, which
 *     is the genuine bug ("the query does not return what the contract claims");
 *   - a column typed `Schema.NullOr(...)` accepts the null, exactly as it would
 *     against the real database;
 *   - every TYPE question - BIGINT vs Number, Date vs ISO string, JSON text vs
 *     native object - is still asked of whatever value the fixture supplied.
 *
 * Only `Schema.Struct` exposes `fields`; anything else is passed through
 * untouched rather than guessed at.
 */
const withSchemaColumns = (schema: unknown, rows: TestCacheRows): TestCacheRows => {
    const fields = (schema as { readonly fields?: Readonly<Record<string, unknown>> }).fields;
    if (fields === undefined) return rows;
    const keys = Object.keys(fields);
    if (keys.length === 0) return rows;
    return rows.map((row) => {
        if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
        const filled: Record<string, unknown> = { ...(row as Record<string, unknown>) };
        for (const key of keys) if (!(key in filled)) filled[key] = null;
        return filled;
    });
};

export const makeTestCacheRead = (options: TestCacheOptions = {}): TestCacheRead => {
    const captured: string[] = [];
    const routes = routeList(options.routes);
    let callIndex = 0;

    const resolve = (sql: string, params?: ReadonlyArray<DuckDbParam>) => Effect.sync(() => {
        captured.push(sql);
        const index = callIndex++;
        const route = routes.find(({ match }) =>
            typeof match === "string" ? sql.includes(match) : (match.lastIndex = 0, match.test(sql))
        );
        const responder = route?.rows ?? options.responses?.[index] ?? options.fallback ?? [];
        const rows = typeof responder === "function" ? responder(sql, params) : responder;
        return asDuckDbRows(normalizeRows(rows));
    });

    /** Decode exactly as `DuckDbConnection.queryAs` does, error mapping included. */
    const decoded = <S extends Schema.Top>(
        schema: S,
        sql: string,
        params?: ReadonlyArray<DuckDbParam>,
    ) =>
        resolve(sql, params).pipe(
            Effect.flatMap((rows) =>
                Schema.decodeUnknownEffect(Schema.Array(schema))(withSchemaColumns(schema, rows)).pipe(
                    Effect.mapError(
                        (issue) => new DuckDbDecodeError({ sql: sqlExcerpt(sql), message: issue.message }),
                    ),
                ),
            ),
        );

    const service: CacheReadService = {
        rows: (schema, sql, params) => decoded(schema, sql, params) as never,
        first: (schema, sql, params) => decoded(schema, sql, params).pipe(
            Effect.map((rows) => rows[0] === undefined ? Option.none() : Option.some(rows[0])),
        ) as never,
        // `raw` has no schema by contract (PRAGMA output, runtime-built
        // aggregates), so there is nothing to decode against here.
        raw: (sql, params) => resolve(sql, params).pipe(
            Effect.map((rows) => ({ columns: [], rows: rows as ReadonlyArray<Record<string, unknown>> })),
        ) as never,
        snapshotPath: "(test-cache)",
    };

    return { service, layer: Layer.succeed(CacheRead, service), captured };
};
