/**
 * A `Clause` is a SQL fragment plus the parameters it binds, kept together so
 * the two cannot drift apart as clauses are composed.
 *
 * WHY THIS IS A TYPE AND NOT A CONVENTION. DuckDB's parameters are POSITIONAL:
 * the Nth `?` in the final statement takes the Nth bound value, so a fragment
 * and its values are one indivisible thing. Every port in wave 2 builds the
 * same shape - a handful of OPTIONAL filters, appended only when present - and
 * the failure mode of doing that by hand is not an error but a WRONG ANSWER:
 * one clause omitted from the SQL while its value stays in the array shifts
 * every later parameter by one, and the query still runs.
 *
 * WHY THE FILTERS ARE APPENDED RATHER THAN GUARDED. The other spelling,
 * `(? IS NULL OR col = ?)`, keeps the parameter count fixed - at the price of
 * binding every optional filter TWICE, which is the same off-by-one hazard with
 * more places to make it, plus a query DuckDB cannot use an index for.
 *
 * WHAT THIS DELETES. The Surreal reader had to splice record-id literals into
 * statement TEXT (`AND session IN [session:a, session:b]`), because Surreal
 * bindings cannot carry record-id arrays. DuckDB row ids are plain strings, so
 * every value here is a bound parameter and that whole injection surface is
 * gone - pinned by a test asserting no builder emits a quote character for any
 * input.
 *
 * The clause SQL is written to be appended to a statement that already has a
 * `WHERE` (in practice `WHERE 1 = 1`, or a first mandatory predicate), which is
 * why each fragment starts with `AND`.
 */
import type { DuckDbParam } from "./types.ts";

export interface Clause {
    readonly sql: string;
    readonly params: ReadonlyArray<DuckDbParam>;
}

/** The absent clause: contributes no SQL and no parameters. */
export const NO_CLAUSE: Clause = { sql: "", params: [] };

/** Concatenate the clauses that are present, flattening their parameters in the
 *  SAME order - the invariant the whole module exists to hold. */
export const andAll = (clauses: ReadonlyArray<Clause>): Clause => {
    const live = clauses.filter((clause) => clause.sql.length > 0);
    if (live.length === 0) return NO_CLAUSE;
    return {
        sql: live.map((clause) => clause.sql).join(" "),
        params: live.flatMap((clause) => [...clause.params]),
    };
};

/**
 * `AND <column> = ?`, or nothing when the filter is absent.
 *
 * The empty STRING counts as absent (it is what an unset CLI flag parses to),
 * but the number ZERO does not - `0` is a value a caller may genuinely filter
 * on, and treating it as absent would silently widen the query.
 */
export const eqClause = (
    column: string,
    value: string | number | null | undefined,
): Clause =>
    value === null || value === undefined || value === ""
        ? NO_CLAUSE
        : { sql: `AND ${column} = ?`, params: [value] };

/**
 * `AND <column> IN (?, ?, …)`, or nothing when `values` is empty.
 *
 * An empty set is NOT `IN ()` (a syntax error) and not a clause that matches
 * nothing: callers that mean "no possible hits" short-circuit before building
 * SQL at all, which is cheaper and clearer than issuing a query that cannot
 * match.
 */
export const inClause = (column: string, values: ReadonlyArray<string>): Clause =>
    values.length === 0
        ? NO_CLAUSE
        : { sql: `AND ${column} IN (${values.map(() => "?").join(", ")})`, params: [...values] };

/** A TIMESTAMP bound. A `Date` is bound AS a Date - the client encodes it (as
 *  ISO-8601 text DuckDB casts to TIMESTAMP), so callers must not pre-format it
 *  into a string of their own spelling. */
const boundClause = (
    column: string,
    operator: ">=" | "<=",
    value: string | Date | null | undefined,
): Clause =>
    value === null || value === undefined || value === ""
        ? NO_CLAUSE
        : { sql: `AND ${column} ${operator} ?`, params: [value] };

export const sinceClause = (
    column: string,
    since: string | Date | null | undefined,
): Clause => boundClause(column, ">=", since);

export const untilClause = (
    column: string,
    until: string | Date | null | undefined,
): Clause => boundClause(column, "<=", until);

/**
 * "N days before now", as a TIMESTAMP - the right-hand side of every windowed
 * read. Binds one parameter: the day count.
 *
 * BOTH CASTS ARE LOad-BEARING against the vendored DuckDB build, and the plain
 * spelling `CURRENT_TIMESTAMP - (? * INTERVAL '1 day')` does not run at all:
 *
 *  - `CURRENT_TIMESTAMP` is a TIMESTAMPTZ, and TIMESTAMPTZ minus INTERVAL is
 *    resolved by the ICU extension, which is not in the static build ax ships.
 *    The binder reports "No function matches '-(TIMESTAMP WITH TIME ZONE,
 *    INTERVAL)'". Casting to a naive TIMESTAMP - which is what every `ts`
 *    column in the schema is, and what the seam pins to UTC - uses core
 *    arithmetic instead.
 *  - `CAST(? AS INTEGER)` because a bound day count has no declared type at
 *    bind time, and the multiplication has to resolve to an INTERVAL.
 */
export const daysAgoExpr = "CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(? AS INTEGER) * INTERVAL '1 day')";

const requireCount = (name: string, value: number): void => {
    if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(
            `${name} must be a non-negative integer, got ${value}. A fractional or NaN bound binds ` +
                "as a DOUBLE and fails inside DuckDB, far from the caller that produced it.",
        );
    }
};

/**
 * `LIMIT ? [OFFSET ?]`. The offset is omitted when it is zero, so the common
 * first page produces the simpler statement.
 *
 * Both bounds are validated rather than bound blindly: they come from user
 * input often enough (`--limit`, a page number) that a NaN reaching the binder
 * is a real possibility, and the resulting DuckDB error names neither the
 * caller nor the flag.
 */
export const limitOffset = (limit: number, offset = 0): Clause => {
    requireCount("limit", limit);
    requireCount("offset", offset);
    return offset === 0
        ? { sql: "LIMIT ?", params: [limit] }
        : { sql: "LIMIT ? OFFSET ?", params: [limit, offset] };
};
