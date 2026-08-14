// packages/schema/src/parse-duckdb-schema.test.ts
import { describe, expect, test } from "bun:test";
import { DUCKDB_TABLE_NAMES, parseDuckdbColumnDefs, parseDuckdbTables } from "./parse-duckdb-schema.ts";

// Mirrors duckdb-parity.test.ts's EXPECTED_TABLES_COMPARED - kept as a
// separate literal (not an import) so a change to either constant is a
// visible two-file diff, not a silent shared mutation.
const EXPECTED_TABLES_COMPARED = 138;

describe("parse-duckdb-schema", () => {
    test("parseDuckdbTables finds every table in the committed DDL", () => {
        expect(parseDuckdbTables().length).toBe(EXPECTED_TABLES_COMPARED);
    });

    test("DUCKDB_TABLE_NAMES is parsed once from the committed DDL and matches parseDuckdbTables", () => {
        expect(DUCKDB_TABLE_NAMES.size).toBe(EXPECTED_TABLES_COMPARED);
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
