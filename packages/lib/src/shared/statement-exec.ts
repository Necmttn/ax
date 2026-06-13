/** @deprecated import from ./surreal.ts (the Graph Access Toolkit). This file
 *  is a re-export shim kept so existing `@ax/lib/shared/statement-exec`
 *  imports keep working; the implementations moved into surreal.ts (statement
 *  execution section) verbatim. */
export {
    DEFAULT_CHUNK_SIZE,
    executeStatementsWith,
    executeStatements,
    type ExecuteOptions,
} from "./surreal.ts";
