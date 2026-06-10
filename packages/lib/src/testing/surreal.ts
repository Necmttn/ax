import { Effect, Layer } from "effect";
import type { RecordId, Surreal } from "surrealdb";
import { SurrealClient, type SurrealClientShape } from "../db.ts";
import type { DbError } from "../errors.ts";

/**
 * Shared in-memory `SurrealClient` test double. One factory replaces the
 * hand-rolled `SurrealClientShape` mocks scattered across test files, so a
 * field added to the shape is absorbed here instead of drifting 40 files.
 *
 * Capabilities (surveyed from the existing mock sites):
 * - **SQL capture**: every `query` call is recorded in `captured` (SQL only)
 *   and `calls` (SQL + bindings).
 * - **Route table**: substring or regex → rows. First matching route wins;
 *   record form (`{ "FROM repository": rows }`) preserves insertion order.
 *   A route's `rows` may be a function of `(sql, bindings)` for dynamic
 *   responses, and may return an Effect (e.g. `Effect.fail(new DbError(...))`)
 *   to inject failures. A thrown error becomes a fiber defect (matches the
 *   old `query: () => { throw ... }` never-called guards).
 * - **Sequenced responses**: `responses[i]` answers the i-th query call
 *   (indexed by call order, counted even when a route matched first).
 * - **Default-empty**: unmatched queries resolve `[[]]` (overridable via
 *   `fallback`).
 * - **Writes**: `upsert` is a no-op that records into `upserts`; `relate`/
 *   `putFile` are plain no-ops and `getFile` resolves `""` (grow recorders
 *   back only when a test actually asserts on them).
 *
 * For bun:test - no vitest dependency.
 */

/** Raw result tuple for one `query` call, or an Effect producing/failing it. */
export type TestSurrealRows =
    | unknown[]
    | Effect.Effect<unknown[], DbError>;

/** Static rows or a handler computing them from the issued SQL + bindings. */
export type TestSurrealResponder =
    | TestSurrealRows
    | ((sql: string, bindings?: Record<string, unknown>) => TestSurrealRows);

export interface TestSurrealRoute {
    /** Substring (`sql.includes`) or regex (`re.test`) matched against the SQL. */
    readonly match: string | RegExp;
    readonly rows: TestSurrealResponder;
}

/** Routes as an ordered array, or a `substring -> rows` record (insertion order). */
export type TestSurrealRoutes =
    | ReadonlyArray<TestSurrealRoute>
    | Readonly<Record<string, TestSurrealResponder>>;

export interface TestSurrealQueryCall {
    readonly sql: string;
    readonly bindings: Record<string, unknown> | undefined;
}

export interface TestSurrealUpsertCall {
    readonly id: RecordId;
    readonly content: Record<string, unknown>;
}

export interface TestSurrealClientOptions {
    /** Pattern → rows for `query` responses. First match wins. */
    readonly routes?: TestSurrealRoutes;
    /**
     * Ordered per-call responses: the i-th `query` call answers with
     * `responses[i]` when no route matched it. The call index advances on
     * every query (routed or not), so positional fixtures stay aligned with
     * the production call order.
     */
    readonly responses?: ReadonlyArray<TestSurrealRows>;
    /** Response when nothing else matched. Default `[[]]`. */
    readonly fallback?: TestSurrealResponder;
    /** Escape-hatch raw client; default `{} as never` (crashes if touched). */
    readonly raw?: Surreal;
}

export interface TestSurrealClient {
    readonly client: SurrealClientShape;
    /** Provide as `Effect.provide(tc.layer)`. */
    readonly layer: Layer.Layer<SurrealClient>;
    /** Every issued SQL string, in call order. */
    readonly captured: string[];
    /** Every `query` call with its bindings. */
    readonly calls: TestSurrealQueryCall[];
    /** Every recorded `upsert`. */
    readonly upserts: TestSurrealUpsertCall[];
}

const toRoutes = (routes: TestSurrealRoutes | undefined): ReadonlyArray<TestSurrealRoute> => {
    if (routes === undefined) return [];
    if (Array.isArray(routes)) return routes as ReadonlyArray<TestSurrealRoute>;
    return Object.entries(routes as Record<string, TestSurrealResponder>).map(
        ([match, rows]) => ({ match, rows }),
    );
};

const matches = (pattern: string | RegExp, sql: string): boolean =>
    typeof pattern === "string" ? sql.includes(pattern) : pattern.test(sql);

const resolve = (
    responder: TestSurrealResponder,
    sql: string,
    bindings: Record<string, unknown> | undefined,
): Effect.Effect<unknown[], DbError> => {
    const rows = typeof responder === "function" ? responder(sql, bindings) : responder;
    return Effect.isEffect(rows) ? rows : Effect.succeed(rows);
};

export const makeTestSurrealClient = (
    opts: TestSurrealClientOptions = {},
): TestSurrealClient => {
    const routes = toRoutes(opts.routes);
    const captured: string[] = [];
    const calls: TestSurrealQueryCall[] = [];
    const upserts: TestSurrealUpsertCall[] = [];
    const fallback: TestSurrealResponder = opts.fallback ?? [[]];
    let callIndex = 0;

    const client: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>(
            sql: string,
            bindings?: Record<string, unknown>,
        ): Effect.Effect<T, DbError> =>
            Effect.suspend(() => {
                captured.push(sql);
                calls.push({ sql, bindings });
                const index = callIndex;
                callIndex += 1;
                const route = routes.find((candidate) => matches(candidate.match, sql));
                const responder =
                    route?.rows ?? opts.responses?.[index] ?? fallback;
                return resolve(responder, sql, bindings);
            }) as Effect.Effect<T, DbError>,

        upsert: (id: RecordId, content: Record<string, unknown>) =>
            Effect.sync(() => {
                upserts.push({ id, content });
            }),

        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),

        raw: opts.raw ?? ({} as never),
    };

    return {
        client,
        layer: Layer.succeed(SurrealClient, client),
        captured,
        calls,
        upserts,
    };
};
