/**
 * The BIGINT-column decode contract for `queryAs`.
 *
 * A DuckDB `BIGINT`/`UBIGINT` column decodes to a JS `bigint` (see
 * `coerceValue` in row-decode.ts: 64-bit widths stay `bigint` so a row's TS type
 * never depends on the magnitude of the value it happens to hold; narrower
 * integer widths and `DOUBLE` come back as `number`). `queryAs` runs the raw
 * rows straight through the caller's Schema, so a field typed `Schema.Number`
 * against a BIGINT column FAILS to decode - a `bigint` is not a `number`. That
 * surfaces as a typed `DuckDbDecodeError`, never a silent lossy convert, which
 * is the point: a BIGINT that does not fit a JS number must not be quietly
 * rounded.
 *
 * When a caller genuinely wants a `number` out of a BIGINT column (the value is
 * known to be small - a count, a token total), use {@link NumberFromBigIntColumn}
 * for that field. It accepts `bigint | number` and yields `number`, and it
 * itself FAILS (never truncates) when the bigint is outside the range a JS
 * number represents exactly. To keep full precision, type the field
 * `Schema.BigInt` instead.
 */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** A numeric column that may arrive as `bigint` (BIGINT/UBIGINT) or `number`,
 *  coerced to `number` - failing, never truncating, when a bigint is outside
 *  the JS safe-integer range. */
export const NumberFromBigIntColumn = Schema.Union([Schema.Number, Schema.BigInt]).pipe(
    Schema.decodeTo(Schema.Number, {
        decode: SchemaGetter.transformOrFail((value: number | bigint) => {
            if (typeof value === "number") return Effect.succeed(value);
            if (value >= MIN_SAFE && value <= MAX_SAFE) return Effect.succeed(Number(value));
            return Effect.fail(
                new SchemaIssue.InvalidValue(Option.some(value), {
                    message:
                        `BIGINT value ${value} is outside Number's safe-integer range ` +
                        `(${Number.MIN_SAFE_INTEGER}..${Number.MAX_SAFE_INTEGER}); type this field ` +
                        "Schema.BigInt to keep full precision instead of a lossy number",
                }),
            );
        }),
        encode: SchemaGetter.transform((n: number): number | bigint => n),
    }),
);
