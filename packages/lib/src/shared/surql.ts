/**
 * Shared seam for turning JS values into SurrealQL literals.
 *
 * This is the WRITE-literal counterpart to `graph-query.ts` (the READ seam):
 * every ingest module that builds `RELATE` / `UPSERT` / `CREATE` / `UPDATE`
 * statements by string interpolation routes its string/JSON literals through
 * here, so SurrealQL escaping is defined exactly once.
 *
 * The load-bearing detail is `stripLoneSurrogates`: ingest excerpts are
 * produced by `text.slice(start, end)`, and a slice boundary can fall in the
 * middle of an emoji's UTF-16 surrogate pair, leaving a lone surrogate.
 * `JSON.stringify` emits that lone surrogate verbatim as a `\uXXXX` escape,
 * and SurrealDB's string parser rejects `\uD800`-`\uDFFF` because a lone
 * surrogate is not a valid Unicode scalar. Stripping lone surrogates before
 * quoting makes any sliced text safe to embed.
 */

/**
 * Matches a lone UTF-16 surrogate code unit: a high surrogate not followed by
 * a low surrogate, or a low surrogate not preceded by a high surrogate. Valid
 * surrogate PAIRS (real emoji / astral chars) do not match and are preserved.
 */
const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Strip lone UTF-16 surrogates. A `slice()` that splits an emoji's surrogate
 * pair leaves a lone surrogate; `JSON.stringify` emits it as a `\uXXXX` escape
 * that SurrealDB's parser rejects. Removing lone surrogates makes any text
 * safe to embed. Valid surrogate PAIRS are left intact. Dropping a half-emoji
 * is acceptable here - the excerpts being embedded are already lossy clips.
 */
const stripLoneSurrogates = (s: string): string => s.replace(LONE_SURROGATE, "");

/**
 * A SurrealQL string literal: JSON-quoted, lone surrogates removed. The one
 * way to embed arbitrary text (transcript excerpts, patterns, paths) into a
 * SurrealQL statement.
 *
 * The parameter type is `string`, but DB-sourced rows routinely hand back
 * `null` / `undefined` where a `string` was declared (a missing column reads
 * back as `undefined`). Rather than throw inside an ingest pipeline, a nullish
 * value is coerced to the empty string. Callers that want a SurrealQL `NONE`
 * for absent values must branch before calling (or use `surrealJsonOption`).
 */
export const surrealString = (value: string): string =>
    JSON.stringify(stripLoneSurrogates(value == null ? "" : value));

/**
 * A SurrealQL literal for an arbitrary JSON-serialisable value - serialises to
 * a JSON string, then quotes. For SET fields typed as `string` that store JSON
 * blobs (e.g. tool-call `args`). When `JSON.stringify` returns `undefined`
 * (e.g. the input is itself `undefined`), the literal `"null"` is used.
 */
export const surrealJson = (value: unknown): string =>
    surrealString(JSON.stringify(value) ?? "null");

/**
 * Like `surrealJson`, but `null` / `undefined` inputs produce the SurrealQL
 * keyword `NONE` (unquoted) rather than a `"null"` string. Mirrors the
 * existing per-file `sqlJsonOption` helpers.
 */
export const surrealJsonOption = (value: unknown): string =>
    value === null || value === undefined ? "NONE" : surrealJson(value);

/**
 * Escape a string for safe use inside a backtick-quoted SurrealQL record key.
 * Mirrors the escaping `evidence-writers.ts` used before this seam existed.
 */
export const surrealRecordKey = (key: string): string =>
    key
        .replace(/\\/g, "\\\\")
        .replace(/`/g, "\\`")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");

/** A SurrealQL record reference: `table:`key``. The single way to splice a
 *  record id built from an arbitrary key string into a statement. */
export const recordRef = (table: string, key: string): string =>
    `${table}:\`${surrealRecordKey(key)}\``;

/** A SurrealQL datetime literal (`d"ISO"`). Accepts a Date or a pre-formed
 *  ISO string. */
export const surrealDate = (value: Date | string): string => {
    const iso = value instanceof Date ? value.toISOString() : value;
    return `d${JSON.stringify(iso)}`;
};

/** `{ name: value, ... }` - values must already be SurrealQL literals. */
export const surrealObject = (
    fields: readonly (readonly [string, string])[],
): string => `{ ${fields.map(([n, v]) => `${n}: ${v}`).join(", ")} }`;

/** `name = value, ...` - values must already be SurrealQL literals. */
export const surrealSet = (
    fields: readonly (readonly [string, string])[],
): string => fields.map(([n, v]) => `${n} = ${v}`).join(", ");

/** `surrealString` or the SurrealQL keyword `NONE` for nullish input. */
export const surrealOptionString = (value: string | null | undefined): string =>
    value === null || value === undefined ? "NONE" : surrealString(value);

/** A truncated integer literal, or `NONE` for nullish / non-finite input. */
export const surrealOptionInt = (value: number | null | undefined): string =>
    value === null || value === undefined || !Number.isFinite(value)
        ? "NONE"
        : Math.trunc(value).toString(10);

/** A datetime literal, or `NONE` for nullish input. */
export const surrealOptionDate = (
    value: Date | string | null | undefined,
): string =>
    value === null || value === undefined ? "NONE" : surrealDate(value);

/** A record reference, or `NONE` for a nullish key. */
export const surrealOptionRecord = (
    table: string,
    key: string | null | undefined,
): string =>
    key === null || key === undefined ? "NONE" : recordRef(table, key);

/**
 * A SurrealQL literal for a column that stores JSON *text*. A value that is
 * already a string is treated as pre-encoded JSON and embedded verbatim (then
 * quoted once); any other value is `JSON.stringify`-d exactly once.
 *
 * This is DELIBERATELY different from `surrealJson`, which always
 * re-stringifies. Collapsing the two double-encodes pre-encoded columns. See
 * the JSON-text columns written by `evidence-writers.ts` (`input_json`,
 * `items`, `raw`).
 */
export const surrealJsonText = (value: unknown): string =>
    surrealString(typeof value === "string" ? value : JSON.stringify(value) ?? "null");

/** Like `surrealJsonText`, but nullish input yields the keyword `NONE`. */
export const surrealJsonTextOption = (value: unknown): string =>
    value === null || value === undefined ? "NONE" : surrealJsonText(value);

/**
 * Duck-type check for a SurrealDB `RecordId` instance. Avoids importing the
 * surrealdb package at the module level (would make surql.ts depend on the
 * DB client) while still emitting a native record reference literal when a
 * `RecordId` flows through `surrealValue`.
 *
 * A `RecordId` has `.table.name` (string) and `.id` (RecordIdValue). The
 * `toString()` shape is `table:id`, so we use that as the canonical check.
 */
const isRecordId = (
    value: unknown,
): value is { table: { name: string }; id: unknown } =>
    typeof value === "object" &&
    value !== null &&
    "table" in value &&
    typeof (value as { table: unknown }).table === "object" &&
    (value as { table: unknown }).table !== null &&
    "name" in (value as { table: { name: unknown } }).table &&
    typeof (value as { table: { name: unknown } }).table.name === "string" &&
    "id" in value;

/**
 * Universal value encoder: turn any JS value into a SurrealQL literal.
 *
 *  - string  → quoted string literal
 *  - finite number → bare numeric literal
 *  - boolean → `true` / `false`
 *  - null / undefined → `NONE`
 *  - Date → datetime literal
 *  - RecordId (string id) → `table:`key`` native record reference
 *  - array → `[...]` of encoded elements (RecordId elements become refs)
 *  - object → `surrealJson` literal (JSON-text column)
 *
 * Used by the telemetry write path, where rows are heterogeneous and a typed
 * per-field builder would be overkill.
 */
export const surrealValue = (value: unknown): string => {
    if (value === null || value === undefined) return "NONE";
    if (typeof value === "string") return surrealString(value);
    if (typeof value === "number") {
        return Number.isFinite(value) ? value.toString(10) : "NONE";
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value instanceof Date) return surrealDate(value);
    // Only a string id yields a native record reference. A RecordId with a
    // non-string id (object/array key) would `String()`-mangle into garbage
    // like `t:`[object Object]``; let it fall through to the JSON fallback.
    if (isRecordId(value) && typeof value.id === "string") {
        return recordRef(value.table.name, value.id);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => surrealValue(v)).join(", ")}]`;
    }
    return surrealJson(value);
};
