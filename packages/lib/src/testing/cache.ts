import { Effect, Layer, Option } from "effect";
import { CacheRead, type CacheReadService } from "../duckdb/seam.ts";
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

const asDuckDbRows = (rows: TestCacheRows): TestCacheRows => rows.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => {
        const timestamp = key === "ts" || key.endsWith("_at");
        return [key, timestamp && typeof value === "string" ? new Date(value) : value];
    }));
});

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

    const service: CacheReadService = {
        rows: (_schema, sql, params) => resolve(sql, params) as never,
        first: (_schema, sql, params) => resolve(sql, params).pipe(
            Effect.map((rows) => rows[0] === undefined ? Option.none() : Option.some(rows[0])),
        ) as never,
        raw: (sql, params) => resolve(sql, params).pipe(
            Effect.map((rows) => ({ columns: [], rows: rows as ReadonlyArray<Record<string, unknown>> })),
        ) as never,
        snapshotPath: "(test-cache)",
    };

    return { service, layer: Layer.succeed(CacheRead, service), captured };
};
