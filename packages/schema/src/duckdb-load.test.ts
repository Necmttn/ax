// packages/schema/src/duckdb-load.test.ts
/**
 * Acceptance: the DDL loads clean into a FRESH DuckDB.
 *
 * Uses a real duckdb binary when one is reachable ($AX_DUCKDB_BIN, then PATH).
 * With no binary the load cannot be proven, so the test SKIPS loudly rather
 * than passing vacuously - the structural suite in duckdb-schema.test.ts is
 * what still runs everywhere.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUCKDB_SCHEMA_PATH, parseDuckdbTables } from "./duckdb-ddl.ts";

const resolveDuckdb = (): string | null => {
    const fromEnv = process.env.AX_DUCKDB_BIN;
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
    const which = Bun.spawnSync(["which", "duckdb"]);
    const path = new TextDecoder().decode(which.stdout).trim();
    return which.exitCode === 0 && path.length > 0 ? path : null;
};

const duckdb = resolveDuckdb();

describe("schema.duckdb.sql loads into a fresh DuckDB", () => {
    if (duckdb === null) {
        test.skip("SKIPPED: no duckdb binary (set AX_DUCKDB_BIN or put duckdb on PATH)", () => {});
        return;
    }

    test("loads with no error and creates every declared table", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-ddl-"));
        try {
            const dbPath = join(dir, "cache.duckdb");
            const script = `.read ${DUCKDB_SCHEMA_PATH}\nSELECT table_name FROM duckdb_tables() ORDER BY table_name;\n`;
            const run = Bun.spawnSync([duckdb, "-batch", "-noheader", "-list", dbPath], {
                stdin: new TextEncoder().encode(script),
            });
            const stderr = new TextDecoder().decode(run.stderr);
            const stdout = new TextDecoder().decode(run.stdout);
            expect(stderr).toBe("");
            expect(run.exitCode).toBe(0);
            const created = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
            expect([...created].sort()).toEqual([...parseDuckdbTables()].sort());
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("re-reading the DDL into the same database is idempotent", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-ddl-"));
        try {
            const dbPath = join(dir, "cache.duckdb");
            const script = `.read ${DUCKDB_SCHEMA_PATH}\n.read ${DUCKDB_SCHEMA_PATH}\nSELECT count(*) FROM duckdb_tables();\n`;
            const run = Bun.spawnSync([duckdb, "-batch", "-noheader", "-list", dbPath], {
                stdin: new TextEncoder().encode(script),
            });
            expect(new TextDecoder().decode(run.stderr)).toBe("");
            expect(run.exitCode).toBe(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("the two FTS surfaces build with PRAGMA create_fts_index", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-ddl-"));
        try {
            const dbPath = join(dir, "cache.duckdb");
            const script = [
                `.read ${DUCKDB_SCHEMA_PATH}`,
                "INSTALL fts; LOAD fts;",
                "PRAGMA create_fts_index('turn', 'id', 'text_excerpt');",
                "PRAGMA create_fts_index('commit', 'id', 'message');",
                "SELECT 'fts-ok';",
            ].join("\n");
            const run = Bun.spawnSync([duckdb, "-batch", "-noheader", "-list", dbPath], {
                stdin: new TextEncoder().encode(`${script}\n`),
            });
            const stdout = new TextDecoder().decode(run.stdout);
            if (run.exitCode !== 0 && /HTTP|network|Failed to download/i.test(new TextDecoder().decode(run.stderr))) {
                // Offline: the fts extension cannot be fetched. Structural coverage stands.
                return;
            }
            expect(run.exitCode).toBe(0);
            expect(stdout).toContain("fts-ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
