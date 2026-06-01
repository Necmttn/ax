/**
 * query: the typed read seam. A `Query` pairs a SurrealQL builder with a
 * row-mapper, so a dashboard caller hands over params and receives typed
 * domain records - it never touches `Record<string, unknown>` or restates
 * field-extraction guards.
 *
 * This is the structural half of the read seam; `graph-query.ts` is the
 * execution half (`runQuery` / `runSingleQuery` resolve `SurrealClient`, apply
 * the mapper, and own the defensive error policy).
 */

/** A multi-row query: params → SQL, plus a per-row mapper to a domain type. */
export interface Query<Params, Row, T> {
    readonly name: string;
    readonly single?: false;
    /** Build the SurrealQL statement. May read `params` to splice clauses. */
    readonly sql: (params: Params) => string;
    /** Optional `$param` bindings passed to `db.query`. */
    readonly bindings?: (params: Params) => Record<string, unknown>;
    /** Map one raw result row to the domain type. */
    readonly mapRow: (row: Row, index: number) => T;
}

/** A single-row query - `runSingleQuery` returns `T | null`. */
export interface SingleQuery<Params, Row, T>
    extends Omit<Query<Params, Row, T>, "single"> {
    readonly single: true;
}

export const defineQuery = <Params, Row extends Record<string, unknown>, T>(
    q: Omit<Query<Params, Row, T>, "single">,
): Query<Params, Row, T> => ({ ...q, single: false });

export const defineSingleQuery = <
    Params,
    Row extends Record<string, unknown>,
    T,
>(
    q: Omit<SingleQuery<Params, Row, T>, "single">,
): SingleQuery<Params, Row, T> => ({ ...q, single: true });
