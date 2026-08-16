// packages/lib/src/sqlite/errors.ts
/** Typed failures of the judgment sidecar. Deliberately three, split the way a
 *  caller has to react: "the sidecar would not open" is an environment problem
 *  a user can fix, "this statement failed" is a bug in the query, and "the rows
 *  did not match the schema" is a bug in the row contract. */
import { Schema } from "effect";

/**
 * The sidecar could not be opened or its schema could not be applied.
 *
 * Rarer than its cache counterpart (`CacheUnavailableError`) and for a different
 * reason: a MISSING sidecar is not an error at all. SQLite creates the file, the
 * DDL is `IF NOT EXISTS`, and an empty judgment database is a perfectly valid
 * state - a user who has never filed a proposal has no proposals. This fires
 * only when the directory cannot be created, the file cannot be opened, or the
 * schema will not apply.
 */
export class SidecarUnavailableError extends Schema.TaggedErrorClass<SidecarUnavailableError>(
    "SidecarUnavailableError",
)("SidecarUnavailableError", {
    path: Schema.String,
    message: Schema.String,
}) {}

/**
 * The connection this service held was closed under it, so the statement never
 * ran. Distinct from {@link SidecarUnavailableError} because it says something
 * stronger and more useful: nothing was attempted, so the caller may simply try
 * again on a fresh connection.
 *
 * WHEN IT HAPPENS. A transaction whose COMMIT failed and whose ROLLBACK then
 * ALSO failed invalidates the shared connection rather than leaving a poisoned
 * one behind (see `transaction` in ./sidecar.ts). Any operation that was already
 * queued on the transaction permit wakes up holding the dead handle. It is
 * checked BEFORE the first statement, under the permit, which is what makes
 * "nothing ran" a fact rather than a hope.
 *
 * CALLERS SHOULD RARELY SEE THIS. `JudgmentLayer` retries such an operation once
 * against a freshly opened connection. It reaches a caller only if a SECOND
 * invalidation lands inside that retry, or if the service was built directly
 * with no layer around it (which the tests do).
 */
export class SidecarConnectionReplacedError extends Schema.TaggedErrorClass<SidecarConnectionReplacedError>(
    "SidecarConnectionReplacedError",
)("SidecarConnectionReplacedError", {
    path: Schema.String,
}) {}

/** A statement failed to prepare, bind, or execute. `sql` is a short excerpt. */
export class SidecarQueryError extends Schema.TaggedErrorClass<SidecarQueryError>(
    "SidecarQueryError",
)("SidecarQueryError", {
    sql: Schema.String,
    message: Schema.String,
}) {}

/** Rows came back fine but did not match the caller's schema. */
export class SidecarDecodeError extends Schema.TaggedErrorClass<SidecarDecodeError>(
    "SidecarDecodeError",
)("SidecarDecodeError", {
    sql: Schema.String,
    message: Schema.String,
}) {}

/** Anything the judgment seam can fail with. Unlike the cache seam there is no
 *  read/write split: the sidecar is READ-WRITE at request time by design, so a
 *  reader and a writer carry the same error channel. */
export type JudgmentError =
    | SidecarUnavailableError
    | SidecarConnectionReplacedError
    | SidecarQueryError
    | SidecarDecodeError;

/** First 200 chars of a statement - mirrors the cache client's `sqlExcerpt`, so
 *  one enormous statement never bloats an error message. */
const SQL_EXCERPT_LEN = 200;

export const sqlExcerpt = (sql: string): string =>
    sql.length > SQL_EXCERPT_LEN ? `${sql.slice(0, SQL_EXCERPT_LEN)}…` : sql;

export const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);
