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
import { SIDECAR_SCHEMA_SQL, parseSqliteColumns, parseSqliteTables } from "./sidecar-ddl.ts";
import { SIDECAR_JUDGMENT_TABLES, SIDECAR_SCHEMA_TABLES } from "./sidecar-tables.ts";
const surrealTables = parseSurrealTables(surql);
const duckTables = parseDuckdbTables();
const duckTableSet = new Set(duckTables);
// v2 keeps the Surreal schema whole across TWO engines - the rebuildable
// DuckDB cache and the SQLite judgment sidecar. Coverage assertions below ask
// "does this table have a home", not "is it in this one file".
const sidecarTableSet = new Set(parseSqliteTables());
const ownedTableSet = new Set([...duckTables, ...sidecarTableSet]);
const columnsOf = (table: string): readonly string[] =>
    SIDECAR_JUDGMENT_TABLES.has(table) ? parseSqliteColumns(table) : parseDuckdbColumns(table);

describe("coverage of the Surreal schema", () => {
    test("every Surreal table has a table of the same name in the engine that owns it", () => {
        const missing = surrealTables.map((t) => t.table).filter((t) => !ownedTableSet.has(t));
        expect(missing).toEqual([]);
        // ...and no table has BOTH homes, which would let a reader answer from
        // whichever it opened, one of them empty.
        const both = [...sidecarTableSet].filter((t) => duckTableSet.has(t));
        expect(both).toEqual([]);
    });

    test("the DDL adds no table the Surreal schema never had", () => {
        // schema.surql is frozen migration-fidelity proof; tables born AFTER the
        // v2 cutover are enumerated here instead of edited into it. Anything not
        // on this list must have a Surreal counterpart.
        const bornAfterSurreal = new Set([
            "schema_comment_state", // #869 COMMENT ON bookkeeping
            "cache_bust_event", // #868 cache-bust ledger (SQL model)
            "fts_index_state", // #909 skip-unchanged bookkeeping for the FTS rebuild
        ]);
        const surrealSet = new Set(surrealTables.map((t) => t.table));
        expect(duckTables.filter((t) => !surrealSet.has(t) && !bornAfterSurreal.has(t))).toEqual([]);
        // ...and the allowlist cannot rot: every entry must still exist in the DDL.
        expect([...bornAfterSurreal].filter((t) => !duckTableSet.has(t))).toEqual([]);
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
            const cols = columnsOf(table);
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
            // `plays_role` is a relation that moved to the sidecar; SQLite serves
            // a leftmost-prefix seek off a composite index, so the single-column
            // rule measured on DuckDB does not transfer. Its own indexes are
            // asserted in sidecar-schema.test.ts against a live database.
            .filter((table) => !SIDECAR_JUDGMENT_TABLES.has(table))
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

    // P2-1 (TIMESTAMPTZ for every datetime) is REVERTED: the bun:ffi DuckDB
    // client cannot decode TIMESTAMP_TZ (probe-confirmed DuckDbUnsupportedTypeError
    // against the real client + dylib). Every datetime column is plain TIMESTAMP
    // now, under a UTC contract (writers normalize to UTC before insert; readers
    // append `Z`). TIMESTAMPTZ is a banned type - see the banned-type guard in
    // duckdb-parity.test.ts for the exhaustive per-column scan; this test just
    // pins the header-level contract.
    test("datetimes are plain TIMESTAMP (UTC contract); TIMESTAMPTZ is banned", () => {
        expect(DUCKDB_SCHEMA_SQL).toMatch(/\bTIMESTAMP\b/);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/\bDATETIME\b/);
        // No column declaration line (comments stripped via `statements`) may use
        // TIMESTAMPTZ - the FFI client can't decode it.
        expect(statements).not.toMatch(/\bTIMESTAMPTZ\b/);
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

describe("arrays (P2-3, reverted)", () => {
    // P2-3 (native DuckDB list columns for scalar array<T> fields) is REVERTED:
    // the bun:ffi DuckDB client cannot decode LIST columns (probe-confirmed
    // DuckDbUnsupportedTypeError against the real client + dylib). Every
    // array<T> field - scalar or record/object - now stays JSON-encoded
    // VARCHAR, same treatment. See the ARRAYS / BANNED TYPES notes in the
    // schema.duckdb.sql header; the exhaustive per-column scan lives in the
    // banned-type guard in duckdb-parity.test.ts.
    test("formerly-native-list scalar array fields are JSON VARCHAR, not list columns", () => {
        const scalarArrayColumns: ReadonlyArray<{ readonly table: string; readonly column: string }> = [
            { table: "agent_def", column: "skills" },
            { table: "hook_fire", column: "injected_titles" },
            { table: "subagent_proposal", column: "example_task_patterns" },
            { table: "wrapped_card", column: "series" },
        ];
        for (const { table, column } of scalarArrayColumns) {
            // `subagent_proposal` moved to the sidecar, where the same rule holds
            // with SQLite's spelling: JSON text, never a native list.
            const inSidecar = SIDECAR_JUDGMENT_TABLES.has(table);
            const sql = inSidecar ? SIDECAR_SCHEMA_SQL : DUCKDB_SCHEMA_SQL;
            const scalarType = inSidecar ? "TEXT" : "VARCHAR";
            expect(sql).toMatch(new RegExp(`^\\s*${column}\\s+${scalarType}\\b`, "m"));
            expect(sql).not.toMatch(new RegExp(`^\\s*${column}\\s+\\w+\\[\\]`, "m"));
        }
    });

    test("a record<> array (hook_fire.top_prior_sessions) stays JSON VARCHAR, unaffected by the revert", () => {
        expect(DUCKDB_SCHEMA_SQL).toMatch(/^\s*top_prior_sessions\s+VARCHAR\s+NOT NULL/m);
        expect(DUCKDB_SCHEMA_SQL).not.toMatch(/^\s*top_prior_sessions\s+VARCHAR\[\]/m);
    });

    test("no native DuckDB list column type (`T[]`) survives anywhere in the DDL", () => {
        expect(statements).not.toMatch(/^\s*"?\w+"?\s+\w+\[\]/m);
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

    // Wave-0 finding P1-2 asked for a `stage: "sidecar"` FLAG on these fourteen
    // tables, because the DDL header said durable judgment lives in the SQLite
    // sidecar while the manifest still called them `active` - a cache rebuild
    // would erase user decisions. `c-sidecar-sqlite` finishes that job: the flag
    // is gone because the TABLES are gone, into schema.sidecar.sql. This is the
    // stronger form of the same assertion - a table cannot be re-added to the
    // cache DDL under a corrected flag, because there is no flag to correct.
    test("the cache DDL defines no judgment table at all", () => {
        const alsoInCache = [...SIDECAR_JUDGMENT_TABLES].filter((t) => duckTables.includes(t));
        expect(alsoInCache).toEqual([]);
        for (const entry of DUCKDB_SCHEMA_TABLES) {
            expect(SIDECAR_JUDGMENT_TABLES.has(entry.table)).toBe(false);
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
        // The union of the two manifests: `SCHEMA_TABLES` predates the split and
        // still lists judgment tables, which now answer from the sidecar.
        const manifest = new Set([
            ...DUCKDB_SCHEMA_TABLES.map((t) => t.table),
            ...SIDECAR_SCHEMA_TABLES.map((t) => t.table),
        ]);
        expect(listed.filter((t) => !manifest.has(t))).toEqual([]);
    });
});
