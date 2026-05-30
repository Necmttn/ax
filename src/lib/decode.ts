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
