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
const EXPECTED_COLUMNS_COMPARED = 1219;

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

/** Maps a Surreal DEFINE FIELD TYPE to the DuckDB type it must translate to. */
function expectedDuckType(t: string): string {
    if (t.startsWith("record<")) return "VARCHAR";
    if (t.startsWith("array<") || t === "object") return "VARCHAR";
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

// Sanity: the parsers above must actually be seeing the committed DDL, not an
// empty string or a stale read - otherwise every "problems.length === 0"
// assertion above would pass vacuously.
describe("parser sanity", () => {
    test("the DuckDB DDL is non-trivial and the parsers found real tables/columns", () => {
        expect(DUCKDB_SCHEMA_SQL.length).toBeGreaterThan(1000);
        expect(duckTables.length).toBe(EXPECTED_TABLES_COMPARED);
    });
});
