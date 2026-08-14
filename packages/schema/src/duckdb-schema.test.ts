// packages/schema/src/duckdb-schema.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import surql from "./schema.surql" with { type: "text" };
import {
    DUCKDB_SCHEMA_SQL,
    parseDuckdbColumns,
    parseDuckdbIndexes,
    parseDuckdbTables,
    parseSurrealTables,
} from "./duckdb-ddl.ts";
import { DUCKDB_SCHEMA_TABLES } from "./duckdb-tables.ts";
const surrealTables = parseSurrealTables(surql);
const duckTables = parseDuckdbTables();
const duckTableSet = new Set(duckTables);

describe("coverage of the Surreal schema", () => {
    test("every Surreal table has a DuckDB table of the same name", () => {
        const missing = surrealTables.map((t) => t.table).filter((t) => !duckTableSet.has(t));
        expect(missing).toEqual([]);
    });

    test("the DDL adds no table the Surreal schema never had", () => {
        const surrealSet = new Set(surrealTables.map((t) => t.table));
        expect(duckTables.filter((t) => !surrealSet.has(t))).toEqual([]);
    });

    test("table names are unique", () => {
        expect(new Set(duckTables).size).toBe(duckTables.length);
    });
});

// Statements only - comments carry Surreal quotes, FTS pragmas, and prose that
// would otherwise trip the "no Surreal syntax" style assertions below.
const statements = DUCKDB_SCHEMA_SQL.split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

describe("row identity", () => {
    test("every table declares id VARCHAR PRIMARY KEY first", () => {
        for (const table of duckTables) {
            expect(parseDuckdbColumns(table)[0]).toBe("id");
        }
        const bodies = DUCKDB_SCHEMA_SQL.match(/^\s*id VARCHAR PRIMARY KEY,?$/gm) ?? [];
        expect(bodies.length).toBe(duckTables.length);
    });

    test("no autoincrement or sequence identity anywhere", () => {
        expect(statements).not.toMatch(/\b(SEQUENCE|nextval|SERIAL|GENERATED\s+ALWAYS)\b/i);
    });
});

describe("edge tables", () => {
    const relationTables = surrealTables.filter((t) => t.relation).map((t) => t.table);

    test("the Surreal schema really does declare relations (guards the parser)", () => {
        expect(relationTables.length).toBeGreaterThan(20);
    });

    test("every relation table becomes (id, in_id, out_id, …)", () => {
        for (const table of relationTables) {
            const cols = parseDuckdbColumns(table);
            expect(cols.slice(0, 3)).toEqual(["id", "in_id", "out_id"]);
        }
    });

    test("every relation table is indexed on both sides", () => {
        // A composite index does NOT serve a leftmost-prefix seek the way a
        // B-tree would: measured on duckdb v1.5.5 (2M rows, 500k distinct
        // keys, 200 sequential `WHERE in_id = ?` point lookups), a composite
        // (in_id, out_id, args) index cost 2.10s user - statistically the
        // same as NO index at all (2.17s user) - while a single-column
        // (in_id) ART index cost 0.12s user. Only a single-column index is
        // actually served, so require one per side.
        const indexes = parseDuckdbIndexes();
        const uncovered = relationTables
            .map((table) => {
                const onTable = indexes.filter((i) => i.table === table);
                return {
                    table,
                    hasIn: onTable.some((i) => i.columns.length === 1 && i.columns[0] === "in_id"),
                    hasOut: onTable.some((i) => i.columns.length === 1 && i.columns[0] === "out_id"),
                };
            })
            .filter((r) => !r.hasIn || !r.hasOut);
        expect(uncovered).toEqual([]);
    });

    test("no column is named bare `in` or `out`", () => {
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s+in\s+VARCHAR/m);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s+out\s+VARCHAR/m);
    });

    // P1-1: Surreal `TYPE RELATION SCHEMAFULL` edges with no FROM/TO are
    // untyped - Surreal's own record id carries the endpoint table name
    // inline, which a bare DuckDB VARCHAR row id would otherwise lose.
    test("every polymorphic (FROM/TO-less) relation carries an in_table/out_table for its varying side(s)", () => {
        const POLYMORPHIC_EDGE_EXTRA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
            concerns: ["in_table", "out_table"],
            resulted_in: ["in_table", "out_table"],
            produced_artifact: ["in_table", "out_table"],
            has_artifact: ["in_table", "out_table"],
            derived_from: ["in_table", "out_table"],
            cites_evidence: ["in_table", "out_table"],
            opportunity: ["out_table"],
            telemetry_of: ["out_table"],
        };
        for (const [table, want] of Object.entries(POLYMORPHIC_EDGE_EXTRA_COLUMNS)) {
            const cols = new Set(parseDuckdbColumns(table));
            for (const col of want) expect(cols.has(col)).toBe(true);
        }
    });

    test("no other relation table carries an in_table/out_table column", () => {
        const polymorphic = new Set(["concerns", "resulted_in", "produced_artifact", "has_artifact", "derived_from", "cites_evidence", "opportunity", "telemetry_of"]);
        for (const table of relationTables) {
            if (polymorphic.has(table)) continue;
            const cols = new Set(parseDuckdbColumns(table));
            expect(cols.has("in_table")).toBe(false);
            expect(cols.has("out_table")).toBe(false);
        }
    });
});

describe("types and Surreal leftovers", () => {
    test("no Surreal syntax survived the translation", () => {
        for (const token of ["DEFINE TABLE", "DEFINE FIELD", "DEFINE INDEX", "SCHEMAFULL", "record<", "option<", "time::now()"]) {
            expect(statements).not.toContain(token);
        }
    });

    test("datetimes are TIMESTAMPTZ, not naive TIMESTAMP (P2-1)", () => {
        expect(DUCKDB_SCHEMA_SQL).toMatch(/\bTIMESTAMPTZ\b/);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/\bDATETIME\b/);
        // No column declaration line may use bare TIMESTAMP - a plain TIMESTAMP
        // silently drops the UTC offset every Surreal datetime carries. Header
        // prose is excluded via `statements` (comment lines stripped above).
        const bareTimestampColumns = statements
            .split("\n")
            .filter((line) => /^\s*"?\w+"?\s+TIMESTAMP\b/.test(line) && !line.includes("TIMESTAMPTZ"));
        expect(bareTimestampColumns).toEqual([]);
    });

    test("index names are unique across the database", () => {
        const names = parseDuckdbIndexes().map((i) => i.name);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        expect(dupes).toEqual([]);
    });

    test("every index targets a declared table", () => {
        for (const index of parseDuckdbIndexes()) expect(duckTableSet.has(index.table)).toBe(true);
    });
});

describe("arrays (P2-3)", () => {
    // Surreal array<scalar> -> native DuckDB list column; everything else
    // (record arrays, objects) stays JSON VARCHAR. See the ARRAYS note in the
    // schema.duckdb.sql header.
    test("scalar array fields are native list columns, not JSON VARCHAR", () => {
        const scalarArrayColumns: ReadonlyArray<{ readonly table: string; readonly column: string; readonly type: string }> = [
            { table: "agent_def", column: "skills", type: "VARCHAR[]" },
            { table: "hook_fire", column: "injected_titles", type: "VARCHAR[]" },
            { table: "subagent_proposal", column: "example_task_patterns", type: "VARCHAR[]" },
            { table: "wrapped_card", column: "series", type: "DOUBLE[]" },
        ];
        for (const { column, type } of scalarArrayColumns) {
            const re = new RegExp(`^\\s*${column}\\s+${type.replace(/\[/g, "\\[").replace(/\]/g, "\\]")}(?![\\w[])`, "m");
            expect(DUCKDB_SCHEMA_SQL).toMatch(re);
        }
    });

    test("a record<> array (hook_fire.top_prior_sessions) is out of P2-3 scope and stays JSON VARCHAR", () => {
        expect(DUCKDB_SCHEMA_SQL).toMatch(/^\s*top_prior_sessions\s+VARCHAR\s+NOT NULL/m);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s*top_prior_sessions\s+VARCHAR\[\]/m);
    });
});

describe("full-text search plan", () => {
    test("FTS is not built by the DDL - only documented in comments", () => {
        expect(statements).not.toMatch(/create_fts_index|FULLTEXT|ANALYZER|PRAGMA/i);
    });

    test("the header documents the two covered surfaces and the dropped ngram index", () => {
        const header = DUCKDB_SCHEMA_SQL.slice(0, DUCKDB_SCHEMA_SQL.indexOf("CREATE TABLE"));
        expect(header).toContain("turn.text_excerpt");
        expect(header).toContain("commit.message");
        expect(header).toContain("PRAGMA create_fts_index");
        expect(header).toMatch(/ngram/i);
        expect(header).toContain("#758");
    });

    test("the omissions are listed, not silently dropped", () => {
        for (const omitted of ["DEFINE BUCKET", "DEFINE ANALYZER", "REMOVE INDEX", "REFERENCE ON DELETE CASCADE"]) {
            expect(DUCKDB_SCHEMA_SQL).toContain(omitted);
        }
    });
});

describe("manifest", () => {
    test("every DDL table has exactly one manifest entry", () => {
        const manifestTables = DUCKDB_SCHEMA_TABLES.map((t) => t.table);
        expect(new Set(manifestTables).size).toBe(manifestTables.length);
        expect([...manifestTables].sort()).toEqual([...duckTables].sort());
    });

    test("every entry carries a non-empty note and a known stage and kind", () => {
        for (const entry of DUCKDB_SCHEMA_TABLES) {
            expect(entry.note.length).toBeGreaterThan(0);
            expect(["active", "conditional", "staged"]).toContain(entry.stage);
            expect(["node", "edge"]).toContain(entry.kind);
        }
    });

    test("kind matches the Surreal relation flag", () => {
        const relation = new Map(surrealTables.map((t) => [t.table, t.relation] as const));
        for (const entry of DUCKDB_SCHEMA_TABLES) {
            expect(entry.kind).toBe(relation.get(entry.table) === true ? "edge" : "node");
        }
    });

    test("covers every table apps/axctl SCHEMA_TABLES lists (parity, not wiring)", () => {
        const insights = readFileSync(
            new URL("../../../apps/axctl/src/queries/insights.ts", import.meta.url).pathname,
            "utf8",
        );
        const block = insights.slice(insights.indexOf("export const SCHEMA_TABLES"));
        const listed = [...block.matchAll(/\{\s*table:\s*"([\w]+)"/g)].map((m) => m[1]!);
        expect(listed.length).toBeGreaterThan(50);
        const manifest = new Set(DUCKDB_SCHEMA_TABLES.map((t) => t.table));
        expect(listed.filter((t) => !manifest.has(t))).toEqual([]);
    });
});
