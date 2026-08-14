// packages/schema/src/duckdb-parity.test.ts
//
// Pins the Surreal -> DuckDB translation property: every `DEFINE FIELD` in
// schema.surql must appear as a DuckDB column in schema.duckdb.sql with the
// mapped type and matching nullability. This is a port of two throwaway
// verification scripts (fidelity.ts / types.ts) that were both CLEAN over
// all 138 tables / 1219 columns - the wave-2 seam port assumes this holds.
import { describe, expect, test } from "bun:test";
import surql from "./schema.surql" with { type: "text" };
import {
    DUCKDB_SCHEMA_SQL,
    parseDuckdbColumnDefs,
    parseDuckdbColumns,
    parseDuckdbTables,
    parseSurrealTables,
} from "./duckdb-ddl.ts";

// Expected table/column counts. Asserted explicitly so the property can never
// silently shrink to comparing zero (or a handful of) tables/columns.
const EXPECTED_TABLES_COMPARED = 138;
// A7 (agent_event.raw prune): schema.surql's `agent_event.raw` field was
// removed (ax never wrote it - buildAgentEventStatement already omitted it
// from the CONTENT it upserts). schema.duckdb.sql's `agent_event.raw` column
// is intentionally left in place (out of scope for that prune) and is simply
// no longer iterated from the Surreal side, so the checked count drops by
// exactly one.
const EXPECTED_COLUMNS_COMPARED = 1218;

// DEFINE FIELD [OVERWRITE] <name> ON [TABLE] <table> ...
// Nested object sub-fields (e.g. measured.ratio) never match \w+ so they are
// skipped by construction - they fold into one JSON column by contract.
const FIELD_RE = /^DEFINE FIELD (?:OVERWRITE )?([\w]+)\s+ON\s+(?:TABLE\s+)?([\w]+)\b/gm;

function surrealFieldsByTable(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const m of surql.matchAll(FIELD_RE)) {
        const [, field, table] = m;
        const list = out.get(table!) ?? [];
        if (!list.includes(field!)) list.push(field!);
        out.set(table!, list);
    }
    return out;
}

// DEFINE FIELD ... TYPE <type> - captures the raw (possibly option<...>) type.
const TYPED_FIELD_RE =
    /^DEFINE FIELD (?:OVERWRITE )?([\w]+)\s+ON\s+(?:TABLE\s+)?([\w]+)\s+TYPE\s+([^\s;]+(?:<[^;]*?>)?)/gm;

interface SurrealFieldType {
    readonly t: string;
    readonly opt: boolean;
}

function surrealTypesByTable(): Map<string, Map<string, SurrealFieldType>> {
    const out = new Map<string, Map<string, SurrealFieldType>>();
    for (const m of surql.matchAll(TYPED_FIELD_RE)) {
        const [, field, table, rawType] = m;
        const opt = rawType!.startsWith("option<");
        const t = opt ? rawType!.slice("option<".length, rawType!.lastIndexOf(">")) : rawType!;
        const inner = out.get(table!) ?? new Map<string, SurrealFieldType>();
        inner.set(field!, { t, opt });
        out.set(table!, inner);
    }
    return out;
}

/** Maps a Surreal DEFINE FIELD TYPE to the DuckDB type it must translate to.
 *
 *  P2-3 (native list columns for scalar `array<T>` fields) and P2-1
 *  (`datetime` -> TIMESTAMPTZ) are both REVERTED (see the UTC CONTRACT / FFI
 *  CLIENT COMPATIBILITY notes in schema.duckdb.sql's header): the bun:ffi
 *  DuckDB client's row-major `duckdb_value_*` accessors cannot decode
 *  TIMESTAMP_TZ or LIST, so every scalar array stays JSON-encoded VARCHAR
 *  (same as record/object arrays - no distinction by element type anymore)
 *  and every datetime is plain TIMESTAMP. */
function expectedDuckType(t: string): string {
    if (t.startsWith("record<")) return "VARCHAR";
    // Every array<T> - scalar or not - is JSON-encoded VARCHAR now; DuckDB
    // native list columns (`T[]`) are banned (FFI client can't decode LIST).
    if (t.startsWith("array<")) return "VARCHAR";
    if (t === "object") return "VARCHAR";
    switch (t) {
        case "string":
            return "VARCHAR";
        case "int":
            return "BIGINT";
        case "float":
            return "DOUBLE";
        case "number":
            return "DOUBLE";
        case "bool":
            return "BOOLEAN";
        case "datetime":
            // Plain TIMESTAMP, never TIMESTAMPTZ - the FFI client cannot decode
            // TIMESTAMP_TZ (DuckDbUnsupportedTypeError, probe-confirmed). Writers
            // must normalize to UTC before insert; readers append `Z`.
            return "TIMESTAMP";
        default:
            return `?${t}`;
    }
}

/** `in` -> `in_id`, `out` -> `out_id`, everything else unchanged. */
function renamedColumn(field: string): string {
    if (field === "in") return "in_id";
    if (field === "out") return "out_id";
    return field;
}

const relationByTable = new Map(parseSurrealTables(surql).map((t) => [t.table, t.relation] as const));
const duckTables = parseDuckdbTables();
const duckTableSet = new Set(duckTables);

// P1-1: Surreal `TYPE RELATION SCHEMAFULL` edges with no FROM/TO are untyped -
// Surreal's own record id carries the endpoint table name inline, which a bare
// DuckDB VARCHAR row id loses. Each such table gets an explicit `in_table`
// and/or `out_table` VARCHAR NOT NULL column for the side(s) that are actually
// polymorphic in real writers (see the POLYMORPHIC EDGES note in
// schema.duckdb.sql's header). These columns have no Surreal DEFINE FIELD
// counterpart, so the strict field<->column equality below must allow them.
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

describe("column-set parity (Surreal field set == DuckDB column set)", () => {
    const surrealFields = surrealFieldsByTable();

    test("every Surreal table's fields map exactly onto its DuckDB columns", () => {
        const problems: string[] = [];
        let checked = 0;

        for (const [table, fields] of surrealFields) {
            if (!duckTableSet.has(table)) {
                problems.push(`${table}: MISSING TABLE`);
                continue;
            }
            checked += 1;
            const cols = new Set(parseDuckdbColumns(table));
            const expected = new Set<string>(["id"]);
            if (relationByTable.get(table) === true) {
                expected.add("in_id");
                expected.add("out_id");
            }
            for (const extra of POLYMORPHIC_EDGE_EXTRA_COLUMNS[table] ?? []) expected.add(extra);
            for (const f of fields) expected.add(renamedColumn(f));

            for (const c of expected) {
                if (!cols.has(c)) problems.push(`${table}.${c}: MISSING column`);
            }
            for (const c of cols) {
                if (!expected.has(c)) problems.push(`${table}.${c}: EXTRA column`);
            }
        }

        // Fieldless relation tables (no DEFINE FIELD at all) still need id/in_id/out_id.
        for (const [table, isRel] of relationByTable) {
            if (!isRel || surrealFields.has(table)) continue;
            if (!duckTableSet.has(table)) {
                problems.push(`${table}: MISSING TABLE`);
                continue;
            }
            checked += 1;
            const cols = new Set(parseDuckdbColumns(table));
            for (const want of ["id", "in_id", "out_id"]) {
                if (!cols.has(want)) problems.push(`${table}.${want}: MISSING column`);
            }
        }

        expect(checked).toBe(EXPECTED_TABLES_COMPARED);
        expect(problems).toEqual([]);
    });
});

describe("type + nullability parity (Surreal DEFINE FIELD TYPE == DuckDB column type/NOT NULL)", () => {
    const surrealTypes = surrealTypesByTable();

    test("every column's DuckDB type matches its mapped Surreal type", () => {
        const problems: string[] = [];
        let checked = 0;

        for (const [table, inner] of surrealTypes) {
            const defs = new Map(parseDuckdbColumnDefs(table).map((d) => [d.name, d] as const));
            for (const [field, { t }] of inner) {
                const want = renamedColumn(field);
                const def = defs.get(want);
                if (def === undefined) {
                    problems.push(`${table}.${want}: no column`);
                    continue;
                }
                checked += 1;
                const exp = expectedDuckType(t);
                if (def.type !== exp) {
                    problems.push(`${table}.${want}: type ${def.type}, expected ${exp} (surreal ${t})`);
                }
            }
        }

        expect(problems).toEqual([]);
        expect(checked).toBe(EXPECTED_COLUMNS_COMPARED);
    });

    test("nullability matches exactly in both directions", () => {
        const problems: string[] = [];
        let checked = 0;

        for (const [table, inner] of surrealTypes) {
            const defs = new Map(parseDuckdbColumnDefs(table).map((d) => [d.name, d] as const));
            for (const [field, { opt }] of inner) {
                const want = renamedColumn(field);
                const def = defs.get(want);
                if (def === undefined) {
                    problems.push(`${table}.${want}: no column`);
                    continue;
                }
                checked += 1;
                if (opt && def.notNull) {
                    problems.push(`${table}.${want}: NOT NULL on an option<> field`);
                }
                if (!opt && !def.notNull) {
                    problems.push(`${table}.${want}: nullable, but the Surreal field is required`);
                }
            }
        }

        expect(problems).toEqual([]);
        expect(checked).toBe(EXPECTED_COLUMNS_COMPARED);
    });
});

// Regression guard for the whole "DDL drifted ahead of the FFI client" conflict
// class (TIMESTAMPTZ + native LIST columns were both added in a review round
// that didn't know the reader can't decode either - see the BANNED TYPES note
// in schema.duckdb.sql's header). The bun:ffi DuckDB client decodes results
// with the deprecated row-major `duckdb_value_*` accessors (it cannot pass
// structs by value, so it can't use the columnar/vector API); a probe against
// the real client + dylib confirmed TIMESTAMP_TZ and LIST both raise
// DuckDbUnsupportedTypeError. None of these may appear as a column type
// anywhere in the DDL, and this test scans every column's actual type token -
// not a fixed set of "known offender" columns - so a future column reintroducing
// any of them fails here regardless of which table it lands on.
describe("banned-type guard (FFI client compatibility)", () => {
    const BANNED_TYPE_TOKENS = [
        "UUID",
        "ENUM",
        "BIT",
        "TIMESTAMP_S",
        "TIMESTAMP_MS",
        "TIMESTAMP_NS",
        "TIMESTAMP_TZ",
        "TIMESTAMPTZ", // short-form alias for TIMESTAMP_TZ / TIMESTAMP WITH TIME ZONE
        "TIME_TZ",
        "TIMETZ", // short-form alias for TIME_TZ
    ];

    test("no column in the DDL uses a banned (FFI-unreadable) type", () => {
        const problems: string[] = [];
        let checked = 0;

        for (const table of duckTables) {
            for (const def of parseDuckdbColumnDefs(table)) {
                checked += 1;
                if (def.type.endsWith("[]")) {
                    // Native DuckDB list column - the FFI client cannot decode LIST.
                    problems.push(`${table}.${def.name}: native LIST column (${def.type}) is banned`);
                    continue;
                }
                if (BANNED_TYPE_TOKENS.includes(def.type.toUpperCase())) {
                    problems.push(`${table}.${def.name}: banned type ${def.type}`);
                }
            }
        }

        // Sanity floor so this can't silently degrade to scanning zero columns.
        expect(checked).toBeGreaterThan(1000);
        expect(problems).toEqual([]);
    });
});

// Sanity: the parsers above must actually be seeing the committed DDL, not an
// empty string or a stale read - otherwise every "problems.length === 0"
// assertion above would pass vacuously.
describe("parser sanity", () => {
    test("the DuckDB DDL is non-trivial and the parsers found real tables/columns", () => {
        expect(DUCKDB_SCHEMA_SQL.length).toBeGreaterThan(1000);
        expect(duckTables.length).toBe(EXPECTED_TABLES_COMPARED);
    });
});
