// packages/schema/src/sidecar-schema.test.ts
//
// The SQLite judgment sidecar's DDL, exercised against a REAL SQLite database in
// a temp directory. A `.sql` file that is never executed is a guess; every
// assertion here loads the actual text through the actual engine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import surql from "./schema.surql" with { type: "text" };
import { DUCKDB_TABLE_NAMES } from "./parse-duckdb-schema.ts";
import { SIDECAR_SCHEMA_SQL, parseSqliteColumns, parseSqliteTables } from "./sidecar-ddl.ts";
import { SIDECAR_JUDGMENT_TABLES } from "./sidecar-tables.ts";

// DEFINE FIELD [OVERWRITE] <name> ON [TABLE] <table> ... - same expression
// duckdb-parity.test.ts uses for the cache half of the property.
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

let dir: string;
let db: Database;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ax-sidecar-ddl-"));
    db = new Database(join(dir, "judgment.sqlite"), { create: true });
    db.exec(SIDECAR_SCHEMA_SQL);
});

afterAll(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
});

const liveTables = (): ReadonlySet<string> =>
    new Set(
        db
            .query<{ name: string }, []>(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .all()
            .map((r) => r.name),
    );

describe("the judgment sidecar DDL", () => {
    test("creates exactly the judgment tables, and nothing else", () => {
        expect([...liveTables()].sort()).toEqual([...SIDECAR_JUDGMENT_TABLES].sort());
    });

    test("is idempotent - applying it twice is not an error", () => {
        expect(() => db.exec(SIDECAR_SCHEMA_SQL)).not.toThrow();
        expect([...liveTables()].sort()).toEqual([...SIDECAR_JUDGMENT_TABLES].sort());
    });

    test("parseSqliteTables agrees with what SQLite actually created", () => {
        expect([...parseSqliteTables(SIDECAR_SCHEMA_SQL)].sort()).toEqual([...liveTables()].sort());
    });

    test("keys every table by a TEXT id primary key", () => {
        for (const table of SIDECAR_JUDGMENT_TABLES) {
            const cols = db
                .query<{ name: string; type: string; pk: number }, []>(`PRAGMA table_info(${table})`)
                .all();
            const pk = cols.filter((c) => c.pk > 0);
            expect(pk.map((c) => c.name)).toEqual(["id"]);
            expect(pk[0]?.type).toBe("TEXT");
        }
    });

    test("stamps its default timestamps as millisecond ISO-8601 UTC, not SQLite's second-grain local form", () => {
        // SQLite's own CURRENT_TIMESTAMP renders `YYYY-MM-DD HH:MM:SS` - no `T`,
        // no `Z`, no milliseconds - which `new Date(...)` reads as LOCAL time.
        // Every timestamp in this schema is a UTC instant, so the DDL stamps the
        // ISO form instead. Checked on a real insert, not by reading the text.
        db.exec(
            "INSERT INTO skill_triage_decision (id, skill_name, decision) VALUES ('t-iso', 'iso-probe', 'keep')",
        );
        const row = db
            .query<{ decided_at: string }, []>(
                "SELECT decided_at FROM skill_triage_decision WHERE id = 't-iso'",
            )
            .get();
        expect(row?.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Math.abs(Date.parse(row!.decided_at) - Date.now())).toBeLessThan(60_000);
    });

    test("indexes both sides of the plays_role edge", () => {
        // The cache's edge-index rule is asserted in duckdb-schema.test.ts and
        // deliberately skips this table, since it lives here now. Read from
        // sqlite_master rather than from the DDL text, so this checks what the
        // engine BUILT.
        const indexed = new Set(
            db
                .query<{ column_name: string }, []>(
                    "SELECT ii.name AS column_name FROM pragma_index_list('plays_role') AS il, " +
                        "pragma_index_info(il.name) AS ii",
                )
                .all()
                .map((r) => r.column_name),
        );
        expect(indexed.has("in_id")).toBe(true);
        expect(indexed.has("out_id")).toBe(true);
    });

    test("owns every judgment table ALONE - the cache DDL defines none of them", () => {
        // One home per table. A table defined in both engines answers from
        // whichever the reader happened to open, and the empty one answers with
        // zero rows instead of an error.
        const alsoInCache = [...SIDECAR_JUDGMENT_TABLES].filter((t) => DUCKDB_TABLE_NAMES.has(t));
        expect(alsoInCache).toEqual([]);
    });

    test("carries every Surreal field of a judgment table that the cache DDL gave up", () => {
        // duckdb-parity.test.ts pins "every DEFINE FIELD in schema.surql has a
        // column in schema.duckdb.sql". Moving fourteen tables out of that file
        // would silently drop them from the property; this is the other half, so
        // no v1 field loses coverage by changing engines.
        let compared = 0;
        for (const [table, fields] of surrealFieldsByTable()) {
            if (!SIDECAR_JUDGMENT_TABLES.has(table)) continue;
            const columns = new Set(parseSqliteColumns(table));
            for (const field of fields) {
                // `in`/`out` are SQL keywords; the cache renamed them to
                // in_id/out_id and the sidecar keeps that spelling.
                const expected = field === "in" ? "in_id" : field === "out" ? "out_id" : field;
                expect({ table, field, has: columns.has(expected) }).toEqual({
                    table,
                    field,
                    has: true,
                });
                compared += 1;
            }
        }
        // Never let the property shrink to comparing nothing.
        expect(compared).toBeGreaterThanOrEqual(90);
    });

    test("holds spar labels as rows, not as a column on a rebuildable session", () => {
        // `session.labels` lives on the DuckDB cache's `session` table, which a
        // re-derive rewrites from the transcript - so a spar stamp written there
        // is erased by the next ingest. The sidecar owns the stamp instead.
        db.exec(
            "INSERT INTO session_label (id, session_id, label) VALUES ('sl-1', 'sess-1', 'spar')",
        );
        expect(() =>
            db.exec(
                "INSERT INTO session_label (id, session_id, label) VALUES ('sl-2', 'sess-1', 'spar')",
            ),
        ).toThrow(/UNIQUE/);
    });
});
