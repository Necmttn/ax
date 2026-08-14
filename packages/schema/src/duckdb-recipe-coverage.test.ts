// packages/schema/src/duckdb-recipe-coverage.test.ts
//
// P2-4: the natural-key contract (packages/lib/src/stable-id.ts) must never
// have a silent gap. Every table in the DuckDB manifest either has a concrete
// recipe in NATURAL_KEY_RECIPES, or is explicitly tracked in RECIPE_TODO -
// there is no third, unaccounted-for state.
import { describe, expect, test } from "bun:test";
import { NATURAL_KEY_RECIPES, RECIPE_TODO } from "@ax/lib/stable-id";
import { DUCKDB_SCHEMA_TABLES } from "./duckdb-tables.ts";

describe("natural-key recipe coverage (P2-4)", () => {
    test("every DUCKDB_SCHEMA_TABLES table has a concrete recipe or an explicit TODO", () => {
        const gaps = DUCKDB_SCHEMA_TABLES.map((t) => t.table).filter(
            (table) => !(table in NATURAL_KEY_RECIPES) && !RECIPE_TODO.has(table),
        );
        expect(gaps).toEqual([]);
    });

    test("a table is never both a concrete recipe AND a TODO at the same time", () => {
        const overlap = DUCKDB_SCHEMA_TABLES.map((t) => t.table).filter(
            (table) => table in NATURAL_KEY_RECIPES && RECIPE_TODO.has(table),
        );
        expect(overlap).toEqual([]);
    });

    test("RECIPE_TODO contains only real DuckDB tables (no stale/renamed entries)", () => {
        const known = new Set(DUCKDB_SCHEMA_TABLES.map((t) => t.table));
        const stale = [...RECIPE_TODO].filter((table) => !known.has(table));
        expect(stale).toEqual([]);
    });

    test("sanity: this test actually compares a non-trivial table set", () => {
        expect(DUCKDB_SCHEMA_TABLES.length).toBeGreaterThan(50);
    });
});
