import { Option, Schema } from "effect";

const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const encodeJsonString = Schema.encodeUnknownOption(Schema.UnknownFromJsonString);

export const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
export type JsonRecord = typeof JsonRecordSchema.Type;

/**
 * JSON decode that distinguishes parse failure from the valid JSON document
 * `null`: `Option.some(null)` for the input `"null"`, `Option.none()` for
 * malformed input. Use this at boundaries where `null` is a legal payload
 * value (e.g. classifier evidence) - `decodeJsonOrNull` conflates the two.
 */
export const decodeJsonOption = (input: string): Option.Option<unknown> =>
    decodeJsonString(input);

/**
 * Best-effort JSON decode at an IO boundary (jsonl lines, file payloads).
 * Returns `null` for malformed input instead of throwing - callers must
 * handle the `null` branch (typically by skipping the record and counting
 * a "corrupted" stat). Backed by Effect Schema so the decode is uniform
 * across ingest entrypoints. NOTE: the valid JSON document `"null"` also
 * decodes to `null`; callers that must tell the two apart use
 * `decodeJsonOption`.
 */
export const decodeJsonOrNull = (input: string): unknown | null => {
    const result = decodeJsonString(input);
    return Option.isSome(result) ? result.value : null;
};

/**
 * Re-derive the native parse error for a warning/error detail: the
 * Option-based schema decode drops the `SyntaxError` that a legacy
 * `JSON.parse` message surfaced. Run this only on the (rare) failure path.
 */
export const jsonParseErrorText = (raw: string): string => {
    try {
        JSON.parse(raw);
        return "schema decode failed";
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
};

/**
 * Decode a JSON string and validate the parsed payload against an Effect
 * Schema. Internal building block for `decodeJsonRecordOrNull`; external
 * callers wanting a typed JSON-string codec should use `jsonField`.
 */
const decodeJsonOrNullAs = <T>(
    schema: Schema.Decoder<T, never>,
    input: string,
): T | null => {
    const decoded = decodeJsonOrNull(input);
    if (decoded === null) return null;
    const result = Schema.decodeUnknownOption(schema)(decoded);
    return Option.isSome(result) ? result.value : null;
};

export const decodeJsonRecordOrNull = (input: string): JsonRecord | null =>
    decodeJsonOrNullAs(JsonRecordSchema, input);

/**
 * Encode a value as a JSON string through Effect Schema's JSON-string
 * transformation. This keeps machine-boundary serialization centralized;
 * human pretty-printing can still use `prettyPrint` from `lib/json.ts`.
 */
export const encodeJsonOrNull = (input: unknown): string | null => {
    const result = encodeJsonString(input);
    return Option.isSome(result) ? result.value : null;
};

export const encodeJson = (input: unknown): string =>
    encodeJsonOrNull(input) ?? "null";

/**
 * A schema whose decode/encode need no services - the only kind usable in
 * the synchronous `jsonField` bridge.
 */
export type PureSchema = Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
};

/**
 * Typed codec for a SurrealDB-v3 JSON-encoded nested field (nested objects
 * are stored as strings - see "Schema rules of thumb" in CLAUDE.md).
 */
export interface JsonField<S extends PureSchema> {
    /**
     * Lenient decode: `null`/`undefined` input, malformed JSON, or a schema
     * mismatch all yield `null`. Callers handle the `null` branch the same
     * way they handled the old `try { JSON.parse } catch` swallow - but the
     * success branch is now typed.
     */
    readonly decode: (input: string | null | undefined) => S["Type"] | null;
    /**
     * Encode a typed value back to its JSON-string column representation.
     * Throws on unencodable values (programmer error at a write boundary).
     */
    readonly encode: (value: S["Type"]) => string;
}

/**
 * Build a typed JSON-string field codec from a nested schema. This is the
 * standard bridge for SurrealDB JSON-encoded columns: replace ad-hoc
 * `try { JSON.parse(raw) as T } catch { ... }` sites with
 * `jsonField(TSchema).decode(raw)` so the parse and the shape check happen
 * in one schema-backed step.
 */
export const jsonField = <S extends PureSchema>(
    schema: S,
): JsonField<S> => {
    const json = Schema.fromJsonString(schema);
    const decodeOption = Schema.decodeUnknownOption(json);
    const encodeOption = Schema.encodeUnknownOption(json);
    return {
        decode: (input) => {
            if (input === null || input === undefined) return null;
            const result = decodeOption(input);
            return Option.isSome(result) ? result.value : null;
        },
        encode: (value) => {
            const result = encodeOption(value);
            if (Option.isSome(result)) return result.value;
            throw new Error("jsonField.encode: value is not encodable as a JSON string");
        },
    };
};

/**
 * Shared codec for the most common nested-field shape: a JSON object record.
 * Arrays, scalars, and `null` JSON decode to `null` (not a record).
 */
export const jsonRecordField: JsonField<typeof JsonRecordSchema> = jsonField(JsonRecordSchema);

/**
 * Shared codec for JSON array columns whose element shape is checked (or
 * coerced) by the caller. Non-array JSON decodes to `null`.
 */
export const jsonArrayField: JsonField<Schema.$Array<Schema.Unknown>> = jsonField(
    Schema.Array(Schema.Unknown),
);
