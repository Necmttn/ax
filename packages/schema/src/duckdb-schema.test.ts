// packages/schema/src/duckdb-schema.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    DUCKDB_SCHEMA_SQL,
    SURREAL_SCHEMA_PATH,
    parseDuckdbColumns,
    parseDuckdbIndexes,
    parseDuckdbTables,
    parseSurrealTables,
} from "./duckdb-ddl.ts";
import { DUCKDB_SCHEMA_TABLES } from "./duckdb-tables.ts";

const surql = readFileSync(SURREAL_SCHEMA_PATH, "utf8");
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
        const indexes = parseDuckdbIndexes();
        for (const table of relationTables) {
            const onTable = indexes.filter((i) => i.table === table);
            expect(onTable.some((i) => i.name.endsWith("_in"))).toBe(true);
            expect(onTable.some((i) => i.name.endsWith("_out"))).toBe(true);
        }
    });

    test("no column is named bare `in` or `out`", () => {
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s+in\s+VARCHAR/m);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s+out\s+VARCHAR/m);
    });
});

describe("types and Surreal leftovers", () => {
    test("no Surreal syntax survived the translation", () => {
        for (const token of ["DEFINE TABLE", "DEFINE FIELD", "DEFINE INDEX", "SCHEMAFULL", "record<", "option<", "time::now()"]) {
            expect(statements).not.toContain(token);
        }
    });

    test("datetimes are TIMESTAMP", () => {
        expect(DUCKDB_SCHEMA_SQL).toMatch(/\bTIMESTAMP\b/);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/\bDATETIME\b/);
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
