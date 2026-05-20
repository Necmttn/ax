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
 */
export const surrealString = (value: string): string =>
    JSON.stringify(stripLoneSurrogates(value));

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
