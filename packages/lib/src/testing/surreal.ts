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
 * - **Writes**: `upsert`/`relate`/`putFile` are no-ops that record into
 *   `upserts`/`relates`/`files`; `getFile` resolves `""`.
 * - **denyWrites**: read-only tests (dashboard/query subjects) pass
 *   `denyWrites: true` so any accidental `upsert`/`relate`/`putFile` fails
 *   loudly instead of being silently swallowed.
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

export interface TestSurrealRelateCall {
    readonly from: Parameters<SurrealClientShape["relate"]>[0];
    readonly edge: Parameters<SurrealClientShape["relate"]>[1];
    readonly to: Parameters<SurrealClientShape["relate"]>[2];
    readonly data: Record<string, unknown> | undefined;
}

export interface TestSurrealPutFileCall {
    readonly bucket: string;
    readonly path: string;
    readonly content: string | Uint8Array;
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
    /**
     * Fail loudly (defect) on any write (`upsert`/`relate`/`putFile`). Use in
     * read-only tests so an accidental mutation surfaces instead of being
     * silently recorded/no-oped.
     */
    readonly denyWrites?: boolean;
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
    /** Every recorded `relate`. */
    readonly relates: TestSurrealRelateCall[];
    /** Every recorded `putFile`. */
    readonly files: TestSurrealPutFileCall[];
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
    const relates: TestSurrealRelateCall[] = [];
    const files: TestSurrealPutFileCall[] = [];
    const fallback: TestSurrealResponder = opts.fallback ?? [[]];
    let callIndex = 0;

    const guardWrite = (op: string): void => {
        if (opts.denyWrites) {
            throw new Error(
                `makeTestSurrealClient: ${op} called but denyWrites is set - this test is read-only`,
            );
        }
    };

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
                guardWrite("upsert");
                upserts.push({ id, content });
            }),

        relate: (from, edge, to, data) =>
            Effect.sync(() => {
                guardWrite("relate");
                relates.push({ from, edge, to, data });
            }),
        putFile: (bucket, path, content) =>
            Effect.sync(() => {
                guardWrite("putFile");
                files.push({ bucket, path, content });
            }),
        getFile: () => Effect.succeed(""),

        raw: opts.raw ?? ({} as never),
    };

    return {
        client,
        layer: Layer.succeed(SurrealClient, client),
        captured,
        calls,
        upserts,
        relates,
        files,
    };
};

// ---------------------------------------------------------------------------
// makeMockDb / runWithMock - the canonical query-test pattern
// ---------------------------------------------------------------------------

/**
 * Responses for {@link makeMockDb}:
 * - an **array** answers `query` calls positionally (`responses[i]` answers
 *   the i-th call), or
 * - a **Map** routes by SQL substring → rows (insertion order, first match
 *   wins; unmatched queries resolve `[[]]`).
 */
export type MockDbResponses =
    | ReadonlyArray<TestSurrealRows>
    | ReadonlyMap<string, TestSurrealResponder>;

export interface MockDbOptions {
    /**
     * Mock DBs are read-only by default: any `upsert`/`relate`/`putFile`
     * fails loudly. Pass `false` for write-path tests (writes are then
     * recorded in `upserts`/`relates`/`files`).
     */
    readonly denyWrites?: boolean;
}

/**
 * Canonical mock `SurrealClient` for query tests - use this instead of
 * hand-rolling a `SurrealClientShape` or a local `makeMockDb` in new test
 * modules (issue #244).
 *
 * ```ts
 * import { makeMockDb, runWithMock } from "@ax/lib/testing/surreal";
 *
 * // Positional: responses[i] answers the i-th query() call.
 * const db = makeMockDb([[[{ total: 7 }]]]);
 * const result = await runWithMock(db, fetchRecall({ q: "auth" }));
 *
 * // Routed: SQL-substring → rows.
 * const { calls, layer } = makeMockDb(new Map([["count() AS total", [[{ total: 7 }]]]]));
 * ```
 *
 * Returns the full {@link TestSurrealClient}, so call sites can destructure
 * whatever they need (`layer`, `client`, `calls`, `captured`, `upserts`, ...).
 * Anything fancier (dynamic responders, fallbacks, raw escape hatch) should
 * call {@link makeTestSurrealClient} directly.
 */
export const makeMockDb = (
    responses: MockDbResponses = [],
    opts: MockDbOptions = {},
): TestSurrealClient =>
    makeTestSurrealClient({
        denyWrites: opts.denyWrites ?? true,
        ...(responses instanceof Map
            ? { routes: [...responses].map(([match, rows]) => ({ match, rows })) }
            : { responses: responses as ReadonlyArray<TestSurrealRows> }),
    });

/** Run an Effect against a {@link makeMockDb} mock's `SurrealClient` layer. */
export const runWithMock = <A, E>(
    db: TestSurrealClient,
    effect: Effect.Effect<A, E, SurrealClient>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(db.layer)));
