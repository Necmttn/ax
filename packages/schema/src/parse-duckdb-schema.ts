// packages/schema/src/parse-duckdb-schema.ts
/**
 * The one place table/column truth over `schema.duckdb.sql` is exposed to the
 * rest of the workspace.
 *
 * PLAN DEVIATION (v2 W1 "derived schema truth", 2026-08-15): the plan this
 * chunk implements assumed the table/column parsers still lived inline
 * inside `duckdb-parity.test.ts` and needed extracting into a runtime
 * module. By the time this chunk ran they had already been extracted - into
 * `duckdb-ddl.ts`, which `duckdb-parity.test.ts`, `duckdb-load.test.ts` and
 * `duckdb-schema.test.ts` already import (package export `@ax/schema/duckdb-ddl`).
 * That module is the ONE place a regex touches the DDL by its own header
 * comment, and re-implementing the same regexes here under a different name
 * would recreate exactly the "two parsers of the same table body silently
 * diverge" risk `duckdb-ddl.ts` warns against (P3-1). So this module does
 * NOT re-parse - it re-exports `duckdb-ddl.ts`'s parsers and adds the one
 * piece that genuinely did not exist yet: `DUCKDB_TABLE_NAMES`, a
 * parsed-once `Set` of every table in the committed DDL. That set is what
 * `duckdb-tables.ts` (the manifest) and `packages/lib/src/stable-id.ts`
 * (`RECIPE_TODO`) now derive from, instead of hand-listing table names that
 * can drift out of sync with the DDL.
 */
export {
    DUCKDB_SCHEMA_SQL,
    parseDuckdbColumnDefs,
    parseDuckdbColumns,
    parseDuckdbIndexes,
    parseDuckdbTables,
    parseSurrealTables,
} from "./duckdb-ddl.ts";
export type { DuckdbColumnDef, DuckdbIndex, SurrealTable } from "./duckdb-ddl.ts";

import { DUCKDB_SCHEMA_SQL, parseDuckdbTables } from "./duckdb-ddl.ts";

/** Every table name in the committed DDL, parsed once. Quoted identifiers
 *  (e.g. `"commit"`, quoted because `commit` collides with a DuckDB
 *  keyword) come back unquoted, matching `parseDuckdbTables`. */
export const DUCKDB_TABLE_NAMES: ReadonlySet<string> = new Set(parseDuckdbTables(DUCKDB_SCHEMA_SQL));
