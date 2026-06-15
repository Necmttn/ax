/** @deprecated import from ./surreal.ts (the Graph Access Toolkit). This file
 *  is a re-export shim kept so existing `@ax/lib/shared/derive-keys` imports
 *  keep working; the implementations moved into surreal.ts (record-id key
 *  derivation section) verbatim. */
export {
    safeKeyPart,
    recordKeyPart,
    isoTimestamp,
    nonEmptyString,
    type TimestampInput,
} from "./surreal.ts";
