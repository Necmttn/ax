/**
 * The writer-side value contract: JS values in, `DuckDbParam`s out.
 *
 * This stays small on purpose: writers hand `put`/`putMany` a
 * `Record<string, DuckDbParam>` and the values are BOUND, not spliced into
 * statement TEXT, so quoting/escaping is not a concern here at all.
 *
 * What is left are the three conversions that are easy to get wrong and that
 * fail LATE - as a decode error in some reader, or as a silently wrong value -
 * rather than at the write:
 *
 *  1. ARRAYS AND NESTED OBJECTS ARE JSON TEXT. The DDL stores them in a VARCHAR
 *     because the bun:ffi client reads results through the row-major
 *     `duckdb_value_*` accessors, which cannot decode a native `LIST` (native
 *     list columns are banned in the DDL for that reason). So a writer must
 *     stringify on the way in, and the reader parses through `JsonArrayColumn` /
 *     `JsonObjectColumn`. {@link jsonParam} is the write half of that pair.
 *  2. `undefined` IS NOT A VALUE. `putMany` refuses a ragged batch - rows with
 *     differing column sets - because a ragged insert would silently write NULLs
 *     into whichever columns a row happened to omit. A writer that builds rows
 *     with `{ project: maybeProject }` therefore produces batches that fail as a
 *     whole whenever one row's optional field is missing. {@link cacheRow} keeps
 *     the key and binds NULL instead.
 *  3. A TIMESTAMP BINDS AS A `Date`. The client encodes it as ISO-8601 text that
 *     DuckDB casts into the column (pinned by a real-database test in
 *     `row.test.ts` - it is a claim about DuckDB, not about this module). A
 *     timestamp that a writer already holds as a string or an epoch number must
 *     be CONVERTED, not passed through, or one column ends up holding two
 *     different encodings depending on which code path wrote the row.
 *
 * Every converter maps "absent or unusable" to `null` rather than throwing or
 * passing the value along. A writer is a bulk path over parsed transcript data:
 * one unparseable timestamp in a million rows must land as a NULL column, not
 * abort an ingest - and a value that reached here already survived its parser.
 */
import type { DuckDbParam } from "./types.ts";

/** A JSON array or object as the VARCHAR the DDL stores. `null`/`undefined`
 *  become SQL NULL rather than the four characters `null`. */
export const jsonParam = (value: unknown): string | null =>
    value === null || value === undefined ? null : JSON.stringify(value);

/**
 * A TIMESTAMP column's value as a `Date`.
 *
 * Accepts what writers actually hold: a `Date`, an ISO string from a transcript,
 * or an epoch-milliseconds number. Anything that does not parse to a real
 * instant is NULL - including the empty string, which is what an absent field
 * usually arrives as.
 */
export const tsParam = (value: Date | string | number | null | undefined): Date | null => {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/** A VARCHAR column's value. The empty string is treated as absent - it is what
 *  an unset field parses to, and `"" IS NULL` is false, so storing it would make
 *  every reader's `IS NOT NULL` filter wrong. */
export const textParam = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

/** A numeric column's value. Zero is kept (it is a value); NaN and the
 *  infinities are not - they bind as DOUBLEs DuckDB stores and every later
 *  aggregate then poisons. */
export const numParam = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

/** A BOOLEAN column's value. Strings are NOT coerced: `"false"` is truthy in JS
 *  and a silent `true` in a column is not worth the convenience. */
export const boolParam = (value: unknown): boolean | null =>
    typeof value === "boolean" ? value : null;

/**
 * Build a row for `put`/`putMany`, normalizing `undefined` to `null` while
 * KEEPING every declared key.
 *
 * Keeping the key is the whole point: `putMany` batches rows of the same shape
 * into one multi-row INSERT and refuses a batch whose rows disagree about their
 * columns, so a writer that dropped absent fields would turn "this session has
 * no project" into a failure of the entire batch.
 */
export const cacheRow = (
    fields: Readonly<Record<string, DuckDbParam>>,
): Record<string, DuckDbParam> => {
    const row: Record<string, DuckDbParam> = {};
    for (const [key, value] of Object.entries(fields)) row[key] = value === undefined ? null : value;
    return row;
};
