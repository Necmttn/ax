/** @deprecated import from ./surreal.ts (the Graph Access Toolkit). This file
 *  is a re-export shim kept so existing `@ax/lib/shared/surql` imports keep
 *  working; the implementations moved into surreal.ts (literals/escaping
 *  section) verbatim. */
export {
    surrealString,
    surrealJson,
    surrealJsonOption,
    surrealRecordKey,
    recordRef,
    surrealDate,
    surrealObject,
    surrealSet,
    surrealOptionString,
    surrealOptionInt,
    surrealOptionDate,
    surrealOptionRecord,
    surrealJsonText,
    surrealJsonTextOption,
    surrealValue,
} from "./surreal.ts";
