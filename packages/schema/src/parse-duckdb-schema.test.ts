// packages/schema/src/parse-duckdb-schema.test.ts
import { describe, expect, test } from "bun:test";
import { DUCKDB_TABLE_NAMES, parseDuckdbColumnDefs, parseDuckdbTables } from "./parse-duckdb-schema.ts";

// Mirrors duckdb-parity.test.ts's EXPECTED_DUCKDB_TABLES - kept as a separate
// literal (not an import) so a change to either constant is a visible two-file
// diff, not a silent shared mutation. It is 138 minus the fourteen judgment
// tables that now live in schema.sidecar.sql; the FULL 138 is still compared
// against the Surreal schema, across both engines, in duckdb-parity.test.ts.
const EXPECTED_DUCKDB_TABLES = 125; // +schema_comment_state (#869)

describe("parse-duckdb-schema", () => {
    test("parseDuckdbTables finds every table in the committed DDL", () => {
        expect(parseDuckdbTables().length).toBe(EXPECTED_DUCKDB_TABLES);
    });

    test("DUCKDB_TABLE_NAMES is parsed once from the committed DDL and matches parseDuckdbTables", () => {
        expect(DUCKDB_TABLE_NAMES.size).toBe(EXPECTED_DUCKDB_TABLES);
        expect([...DUCKDB_TABLE_NAMES].sort()).toEqual([...parseDuckdbTables()].sort());
    });

    test("the quoted \"commit\" table name is unquoted to commit", () => {
        expect(DUCKDB_TABLE_NAMES.has("commit")).toBe(true);
        expect(DUCKDB_TABLE_NAMES.has('"commit"')).toBe(false);
        expect(parseDuckdbTables()).toContain("commit");
        expect([...DUCKDB_TABLE_NAMES].some((t) => t.includes('"'))).toBe(false);
    });

    test("parseDuckdbColumnDefs finds the commit table's declared columns", () => {
        const cols = parseDuckdbColumnDefs("commit");
        expect(cols.length).toBeGreaterThan(0);
        expect(cols[0]).toEqual({ name: "id", type: "VARCHAR", notNull: false });
        const sha = cols.find((c) => c.name === "sha");
        expect(sha).toEqual({ name: "sha", type: "VARCHAR", notNull: true });
    });
});
