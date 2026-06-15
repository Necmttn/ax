/** @deprecated import from ./surreal.ts (the Graph Access Toolkit). This file
 *  is a re-export shim kept so existing `@ax/lib/shared/record-select` imports
 *  keep working; the implementations moved into surreal.ts (record selection
 *  section) verbatim, including the SurrealDB 3.0.x id-IN-list quirk docs. */
export {
    recordListSource,
    refListSource,
    selectByIds,
} from "./surreal.ts";
