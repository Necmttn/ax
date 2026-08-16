// packages/lib/src/sqlite/columns.ts
/**
 * The sidecar's row-decode CONTRACT, stated once as schemas.
 *
 * Same job as `@ax/lib/duckdb/columns` and a DIFFERENT set of hazards, because
 * SQLite has fewer types than DuckDB rather than more. Three column meanings are
 * not visible in the SQL and are easy to get subtly wrong:
 *
 *   TIMESTAMP  -> {@link TimestampColumn}  (TEXT holding an ISO-8601 UTC instant)
 *   BOOLEAN    -> {@link BooleanColumn}    (INTEGER 0 or 1)
 *   JSON       -> {@link JsonArrayColumn} / {@link JsonObjectColumn}
 *
 * WHY A TIMESTAMP IS TEXT AND NOT A NUMBER. Epoch integers sort and compare
 * correctly and are unreadable in a `sqlite3` shell; ISO-8601 UTC text sorts and
 * compares correctly TOO (it is lexicographically ordered for a fixed offset and
 * fixed precision) and can be read by a human debugging a judgment row at 2am.
 * The DDL's own defaults use `strftime('%Y-%m-%dT%H:%M:%fZ','now')` for the same
 * reason - see the TIMESTAMPS block in schema.sidecar.sql.
 *
 * WHY THE BOOLEAN CODEC IS STRICT. SQLite will happily store `'true'`, `2` or
 * `NULL` in a column the DDL calls INTEGER: it has no boolean type and no
 * constraint here. Decoding "anything truthy" would turn a writer bug into a
 * plausible-looking `true`, so {@link BooleanColumn} accepts 0 and 1 and refuses
 * everything else at the column.
 */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";

/** A plain text column. Named for symmetry, so a row contract reads as a list of
 *  column CONTRACTS rather than a mix of contracts and bare primitives. */
export const TextColumn = Schema.String;

/** An INTEGER or REAL column read as a JS number. */
export const NumberColumn = Schema.Number;

const EXCERPT_LEN = 120;

const excerptOf = (text: string): string =>
    text.length > EXCERPT_LEN ? `${text.slice(0, EXCERPT_LEN)}…` : text;

/**
 * A TEXT column holding an ISO-8601 UTC instant, decoded to a JS `Date`.
 *
 * Strict on purpose. SQLite's own `CURRENT_TIMESTAMP` renders
 * `YYYY-MM-DD HH:MM:SS`, which `new Date()` parses as LOCAL time - so a row
 * written by a statement that reached for `CURRENT_TIMESTAMP` instead of the
 * DDL's default would come back hours off, on any non-UTC host, with no error
 * anywhere. Requiring the `T`/`Z` form makes that a decode failure naming the
 * column rather than a wrong number in a report.
 */
export const TimestampColumn = Schema.String.pipe(
    Schema.decodeTo(Schema.DateValid, {
        decode: SchemaGetter.transformOrFail((text: string) => {
            const ms = Date.parse(text);
            if (Number.isNaN(ms)) {
                return Effect.fail(
                    new SchemaIssue.InvalidValue(Option.some(excerptOf(text)), {
                        message: `not a parseable timestamp; this column holds an ISO-8601 UTC instant (see @ax/lib/sqlite/columns), and the value was: ${excerptOf(text)}`,
                    }),
                );
            }
            if (!text.includes("T") || !text.endsWith("Z")) {
                return Effect.fail(
                    new SchemaIssue.InvalidValue(Option.some(excerptOf(text)), {
                        message:
                            `parseable, but not in the UTC form this schema stores (\`YYYY-MM-DDTHH:MM:SS.sssZ\`), so ` +
                            `reading it would silently apply the HOST's time zone. Got: ${excerptOf(text)}. A row in ` +
                            "this shape usually means a writer used SQLite's CURRENT_TIMESTAMP instead of the DDL's " +
                            "strftime default.",
                    }),
                );
            }
            return Effect.succeed(new Date(ms));
        }),
        encode: SchemaGetter.transform((value: Date) => value.toISOString()),
    }),
);

/** An INTEGER column holding 0 or 1, decoded to a JS boolean. */
export const BooleanColumn = Schema.Number.pipe(
    Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transformOrFail((n: number) =>
            n === 0 || n === 1
                ? Effect.succeed(n === 1)
                : Effect.fail(
                      new SchemaIssue.InvalidValue(Option.some(n), {
                          message: `expected 0 or 1; SQLite has no boolean type, so this schema stores one as an INTEGER (see @ax/lib/sqlite/columns) and got ${n}`,
                      }),
                  ),
        ),
        encode: SchemaGetter.transform((value: boolean) => (value ? 1 : 0)),
    }),
);

const jsonIssue = (text: string, why: string) => {
    const excerpt = excerptOf(text);
    return new SchemaIssue.InvalidValue(Option.some(excerpt), {
        message: `${why}; this column holds JSON text (see @ax/lib/sqlite/columns), and the value ${
            excerpt === text ? "was" : "began"
        }: ${excerpt}`,
    });
};

const parseJson = (text: string): Effect.Effect<unknown, SchemaIssue.InvalidValue> =>
    Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (err) =>
            jsonIssue(text, `not valid JSON (${err instanceof Error ? err.message : String(err)})`),
    });

/** A TEXT column holding a JSON ARRAY, decoded to `ReadonlyArray<item>`. */
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

/** A TEXT column holding a JSON OBJECT, decoded through `shape`. */
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
