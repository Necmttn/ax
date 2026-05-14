import { Option, Schema } from "effect";

const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

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
