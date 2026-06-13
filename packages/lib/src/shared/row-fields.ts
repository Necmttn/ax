/** @deprecated import from ./surreal.ts (the Graph Access Toolkit). This file
 *  is a re-export shim kept so existing `@ax/lib/shared/row-fields` imports
 *  keep working; the implementations moved into surreal.ts (typed row field
 *  access section) verbatim. */
export {
    isRecord,
    stringField,
    dateField,
    numberFieldOrNull,
    countField,
    recordIdString,
} from "./surreal.ts";
