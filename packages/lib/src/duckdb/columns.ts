/**
 * The row-decode CONTRACT, stated once as schemas.
 *
 * `queryAs` runs raw decoded rows straight through the caller's `Schema`, so
 * what a column type MEANS in TypeScript is decided at each call site - and
 * three of those meanings are not obvious from the SQL, are easy to get subtly
 * wrong, and fail in ways that look like data problems rather than type
 * problems. This module is where each one is written down, so a reader porting a
 * query picks a named column codec instead of guessing:
 *
 *   TIMESTAMP  -> {@link TimestampColumn}   (a JS `Date`, UTC, millisecond grain)
 *   JSON array -> {@link JsonArrayColumn}   (VARCHAR holding a JSON array)
 *   JSON object-> {@link JsonObjectColumn}  (VARCHAR holding a JSON object)
 *   BIGINT     -> {@link NumberFromBigIntColumn} (or `Schema.BigInt` to keep precision)
 *
 * WHY JSON-IN-VARCHAR AT ALL. The DDL stores every array and every nested object
 * as JSON text in a VARCHAR (see schema.duckdb.sql's ARRAYS and FFI CLIENT
 * COMPATIBILITY sections): the bun:ffi client cannot pass structs by value, so it
 * reads results through the row-major `duckdb_value_*` accessors, which cannot
 * decode a native `LIST`. Native list columns are banned in the DDL for that
 * reason. Parsing is therefore a READ-SIDE job, done here, per field, ON DEMAND -
 * a query that does not select the column pays nothing, and a malformed value is
 * a typed decode failure naming what it found rather than a `JSON.parse` throw
 * escaping as a defect.
 */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

export { NumberFromBigIntColumn } from "./bigint-column.ts";

/** JS safe-integer bounds as bigints - the range a BIGINT can cross into a
 *  `number` without losing exactness. Used by {@link LooseCellColumn}. */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * A `TIMESTAMP` column.
 *
 * The client already turns a TIMESTAMP cell into a JS `Date` (`coerceValue` in
 * row-decode.ts), so this is an instance check rather than a parse - but it is
 * NOT a no-op, and that is the point. `coerceValue` falls back to the RAW TEXT
 * when a timestamp does not parse, so a column typed loosely would silently hand
 * a caller a `string` where every downstream `.getTime()` breaks far from the
 * cause. Here it is a decode failure at the column.
 *
 * PRECISION: DuckDB stores TIMESTAMP at microsecond grain; a JS `Date` holds
 * whole milliseconds, so the last three digits are TRUNCATED on the way out.
 * That is accepted (every ax timestamp is millisecond-grain to begin with) and
 * pinned by a test in row-decode.test.ts. A caller that genuinely needs
 * microseconds must project the column in SQL (`CAST(ts AS VARCHAR)` or
 * `epoch_us(ts)`) and read text/bigint instead of using this.
 *
 * UTC: the seam pins every connection to `TimeZone='UTC'`, and the DDL requires
 * writers to normalize before insert, so the naive TIMESTAMP this decodes is a
 * UTC instant.
 */
export const TimestampColumn = Schema.DateValid;

/** A plain text column. Named for symmetry, so a ported query reads as a list of
 *  column CONTRACTS rather than a mix of contracts and bare primitives. */
export const TextColumn = Schema.String;

/**
 * A JSON column can hold a megabyte of transcript text, so the EXCERPT - not the
 * full value - is what goes into the issue, as both the reported actual value
 * and the message. An issue that embeds the whole value turns one bad row into a
 * megabyte in every log line that renders it, and the first 120 characters are
 * what actually tells you which column and which row went wrong.
 */
const EXCERPT_LEN = 120;

const excerptOf = (text: string): string =>
    text.length > EXCERPT_LEN ? `${text.slice(0, EXCERPT_LEN)}…` : text;

const jsonIssue = (text: string, why: string) => {
    const excerpt = excerptOf(text);
    return new SchemaIssue.InvalidValue(Option.some(excerpt), {
        message: `${why}; this column holds JSON text (see @ax/lib/duckdb/columns), and the value ${
            excerpt === text ? "was" : "began"
        }: ${excerpt}`,
    });
};

/** `JSON.parse` that fails as a schema issue instead of throwing. */
const parseJson = (text: string): Effect.Effect<unknown, SchemaIssue.InvalidValue> =>
    Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (err) => jsonIssue(text, `not valid JSON (${err instanceof Error ? err.message : String(err)})`),
    });

/**
 * A VARCHAR column holding a JSON ARRAY, decoded to `ReadonlyArray<item>`.
 *
 * The cast below is at a genuine parse boundary: `JSON.parse` returns `unknown`,
 * this function proves it is an array, and the TARGET schema (`Schema.Array(item)`)
 * then validates every element - so an array of the wrong element type is still a
 * decode failure, not a value smuggled past the type system.
 */
export const JsonArrayColumn = <S extends Schema.Top>(item: S) =>
    Schema.String.pipe(
        Schema.decodeTo(Schema.Array(item), {
            decode: SchemaGetter.transformOrFail((text: string) =>
                parseJson(text).pipe(
                    Effect.flatMap((value) =>
                        Array.isArray(value)
                            ? Effect.succeed(value as ReadonlyArray<S["Encoded"]>)
                            : Effect.fail(jsonIssue(text, `expected a JSON array, got ${typeof value}`)),
                    ),
                ),
            ),
            encode: SchemaGetter.transform((value: ReadonlyArray<S["Encoded"]>) => JSON.stringify(value)),
        }),
    );

/**
 * A VARCHAR column holding a JSON OBJECT, decoded through `shape`.
 *
 * Same boundary rule as {@link JsonArrayColumn}: this proves the parsed value is
 * a non-null, non-array object and `shape` validates its contents.
 */
export const JsonObjectColumn = <S extends Schema.Top>(shape: S) =>
    Schema.String.pipe(
        Schema.decodeTo(shape, {
            decode: SchemaGetter.transformOrFail((text: string) =>
                parseJson(text).pipe(
                    Effect.flatMap((value) =>
                        typeof value === "object" && value !== null && !Array.isArray(value)
                            ? Effect.succeed(value as S["Encoded"])
                            : Effect.fail(
                                  jsonIssue(
                                      text,
                                      `expected a JSON object, got ${Array.isArray(value) ? "an array" : typeof value}`,
                                  ),
                              ),
                    ),
                ),
            ),
            encode: SchemaGetter.transform((value: S["Encoded"]) => JSON.stringify(value)),
        }),
    );

/**
 * One cell of a row whose column set is not known at compile time.
 *
 * Most readers name their columns and type them, and a BIGINT column gets
 * {@link NumberFromBigIntColumn}. Two surfaces cannot do that: `ax insights`
 * runs one of 30 differently-shaped views chosen at runtime, and the evidence
 * report renders whatever columns those views return. They decode rows as
 * `Record<string, unknown>`, which means nothing declares the BIGINT columns -
 * and a `COUNT(*)` cell arrives as a JS `bigint` (see `coerceValue` in
 * row-decode.ts: 64-bit widths stay `bigint`).
 *
 * That is the undecoded-BIGINT trap, and its usual shape is a WRONG ANSWER
 * rather than an error: the report serializes its rows with `JSON.stringify`,
 * which THROWS on a bigint, while a `typeof x === "number"` guard elsewhere
 * would simply read false and drop the value.
 *
 * So the conversion is declared here, at the read boundary, rather than hidden
 * in a `JSON.stringify` replacer - a replacer would make the symptom go away
 * while leaving every other consumer of the same row holding a bigint.
 *
 * An out-of-range bigint becomes its DECIMAL STRING, not a rounded number.
 * `NumberFromBigIntColumn` fails instead, which is right for a named column a
 * caller can retype as `Schema.BigInt`; here there is no such caller, and a
 * whole report must not die because one cell exceeded 2^53.
 */
export const LooseCellColumn = Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Unknown, {
        decode: SchemaGetter.transform((value: unknown): unknown => {
            if (typeof value !== "bigint") return value;
            return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT
                ? Number(value)
                : value.toString();
        }),
        encode: SchemaGetter.transform((value: unknown): unknown => value),
    }),
);

/** A row whose columns are not known at compile time. See {@link LooseCellColumn}. */
export const LooseRowSchema = Schema.Record(Schema.String, LooseCellColumn);
export type LooseRow = typeof LooseRowSchema.Type;
