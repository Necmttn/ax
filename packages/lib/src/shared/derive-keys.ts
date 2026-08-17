/**
 * Record-id key derivation: turn arbitrary text into a safe key part.
 *
 * A re-export of the implementations in `./row-fields.ts`, kept because the
 * ingest tree imports this path in ~15 places and the name says what the
 * callers want. Nothing here is engine-specific.
 */
export {
    safeKeyPart,
    recordKeyPart,
    isoTimestamp,
    nonEmptyString,
    type TimestampInput,
} from "./row-fields.ts";
