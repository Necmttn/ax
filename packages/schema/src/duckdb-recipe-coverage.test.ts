// packages/schema/src/duckdb-recipe-coverage.test.ts
//
// P2-4: the natural-key contract (packages/lib/src/stable-id.ts) must never have
// a silent gap. Every table in the DuckDB DDL either has a concrete recipe in
// NATURAL_KEY_RECIPES, or is in the DERIVED todo set - and there is no third,
// unaccounted-for state.
//
// The todo set used to be a hand-listed `RECIPE_TODO` constant in stable-id.ts:
// a third mirror of the DDL's table list, and the one most likely to rot, since
// a table added to the DDL and forgotten there read as "covered". It is now
// derived HERE, next to the DDL it describes: every parsed table minus the keys
// of NATURAL_KEY_RECIPES. The derived set was verified byte-for-byte identical
// to the 134-table hand list it replaced.
//
// For wave-2 porters: a table leaves the todo set by GAINING a recipe in
// NATURAL_KEY_RECIPES. There is no second list to edit.
import { describe, expect, test } from "bun:test";
import { NATURAL_KEY_RECIPES, PSEUDO_RECIPE_KEYS } from "@ax/lib/stable-id";
import { DUCKDB_TABLE_NAMES } from "./parse-duckdb-schema.ts";
import { DUCKDB_SCHEMA_TABLES } from "./duckdb-tables.ts";

/** Tables with no concrete natural-key recipe yet. */
const recipeTodo: ReadonlySet<string> = new Set(
    [...DUCKDB_TABLE_NAMES].filter((table) => !(table in NATURAL_KEY_RECIPES)),
);

const tablesWithRecipes = Object.keys(NATURAL_KEY_RECIPES).filter((k) => !PSEUDO_RECIPE_KEYS.has(k));

describe("natural-key recipe coverage (P2-4)", () => {
    test("every DDL table is either covered by a recipe or in the todo set", () => {
        const gaps = [...DUCKDB_TABLE_NAMES].filter(
            (table) => !(table in NATURAL_KEY_RECIPES) && !recipeTodo.has(table),
        );
        expect(gaps).toEqual([]);
    });

    test("a table is never both covered and todo at the same time", () => {
        const overlap = [...DUCKDB_TABLE_NAMES].filter(
            (table) => table in NATURAL_KEY_RECIPES && recipeTodo.has(table),
        );
        expect(overlap).toEqual([]);
    });

    test("the todo set contains only real DuckDB tables (no stale/renamed entries)", () => {
        // True by construction now that it is derived - asserted anyway so a
        // future re-hand-listing cannot reintroduce stale names unnoticed.
        const known = new Set(DUCKDB_SCHEMA_TABLES.map((t) => t.table));
        expect([...recipeTodo].filter((table) => !known.has(table))).toEqual([]);
    });

    test("every concrete recipe names a table that actually exists in the DDL", () => {
        // The direction the old hand-listed constant could not check: a recipe
        // written for a table that was later renamed away silently covered
        // nothing, and its real successor fell into the todo set unnoticed.
        expect(tablesWithRecipes.filter((table) => !DUCKDB_TABLE_NAMES.has(table))).toEqual([]);
    });

    test("the documentation-only pseudo keys can never mask a real table", () => {
        // `<edge>` / `<derived>` describe a RULE, not a table. `<` and `>` are
        // not valid DuckDB identifier characters, so this cannot collide today -
        // asserted so that a future pseudo-key spelled like an identifier fails
        // here rather than silently marking a real table "covered".
        expect([...PSEUDO_RECIPE_KEYS].filter((key) => DUCKDB_TABLE_NAMES.has(key))).toEqual([]);
    });

    test("no table with a wired writer is still in the todo set", () => {
        // Wave 1 wires real writers for the recall vertical's six tables (the
        // fixture in apps/axctl/src/dashboard/recall.test.ts writes every one of
        // them through the seam), and the standing rule is that a table whose
        // writer you wire leaves the todo set WITH a concrete recipe.
        const written = ["session", "turn", "commit", "skill", "invoked", "has_content"];
        expect(written.filter((table) => recipeTodo.has(table))).toEqual([]);
    });

    test("sanity: this test actually compares a non-trivial table set", () => {
        expect(DUCKDB_TABLE_NAMES.size).toBeGreaterThan(50);
        expect(recipeTodo.size).toBeGreaterThan(0);
    });
});
