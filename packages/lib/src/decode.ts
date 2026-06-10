import { Option, Schema } from "effect";

const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);
const encodeJsonString = Schema.encodeUnknownOption(Schema.UnknownFromJsonString);

export const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
export type JsonRecord = typeof JsonRecordSchema.Type;

/**
 * Best-effort JSON decode at an IO boundary (jsonl lines, file payloads).
 * Returns `null` for malformed input instead of throwing - callers must
 * handle the `null` branch (typically by skipping the record and counting
 * a "corrupted" stat). Backed by Effect Schema so the decode is uniform
 * across ingest entrypoints.
 */
export const decodeJsonOrNull = (input: string): unknown | null => {
    const result = decodeJsonString(input);
    return Option.isSome(result) ? result.value : null;
};

/**
 * Decode a JSON string and validate the parsed payload against an Effect
 * Schema. This is the preferred boundary helper when callers know the shape
 * they expect from stdin, JSONL, DB labels, or file payloads.
 */
export const decodeJsonOrNullAs = <T>(
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

export interface JsonFieldOptions {
    /**
     * Called when a non-null input fails to decode (malformed JSON or a
     * schema mismatch). Lets callers count "corrupted" rows without giving
     * up the lenient typed-or-null decode contract.
     */
    readonly onDecodeFailure?: (input: string) => void;
}

/**
 * Typed codec for a SurrealDB-v3 JSON-encoded nested field (nested objects
 * are stored as strings - see "Schema rules of thumb" in CLAUDE.md).
 */
export interface JsonField<S extends PureSchema> {
    /** The underlying `Schema.fromJsonString(schema)` for composition. */
    readonly schema: Schema.fromJsonString<S>;
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
    options?: JsonFieldOptions,
): JsonField<S> => {
    const json = Schema.fromJsonString(schema);
    const decodeOption = Schema.decodeUnknownOption(json);
    const encodeOption = Schema.encodeUnknownOption(json);
    return {
        schema: json,
        decode: (input) => {
            if (input === null || input === undefined) return null;
            const result = decodeOption(input);
            if (Option.isSome(result)) return result.value;
            options?.onDecodeFailure?.(input);
            return null;
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
