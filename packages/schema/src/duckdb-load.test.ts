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
import { fileURLToPath } from "node:url";
import { parseDuckdbTables } from "./duckdb-ddl.ts";

const DUCKDB_SCHEMA_PATH = fileURLToPath(new URL("./schema.duckdb.sql", import.meta.url));

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
            const stdout = new TextDecoder().decode(run.stdout).trim();
            expect(stdout).toBe(String(parseDuckdbTables().length));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // P2-5: the earlier version of this suite only loaded the DDL and listed
    // tables - it never proved a single row could actually be written and
    // read back. This test inserts one representative row per risky
    // translation decision from the cross-review (P1-1 polymorphic edges, the
    // UTC contract for plain TIMESTAMP columns, P2-2 DEFAULT-only-on-omit
    // semantics, JSON-encoded scalar arrays) and asserts the values survive a
    // round trip through the real DuckDB engine.
    //
    // TIMESTAMPTZ + native list columns (P2-1/P2-3 as originally reviewed) are
    // REVERTED: the bun:ffi DuckDB client's row-major `duckdb_value_*`
    // accessors cannot decode TIMESTAMP_TZ or LIST (probe-confirmed
    // DuckDbUnsupportedTypeError). This test now exercises the UTC-contract
    // TIMESTAMP path and JSON-encoded VARCHAR arrays in their place.
    test("representative inserts round-trip through UTC timestamps, JSON-encoded arrays, defaults, and a polymorphic edge", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-duckdb-ddl-"));
        try {
            const dbPath = join(dir, "cache.duckdb");
            const script = [
                `.read ${DUCKDB_SCHEMA_PATH}`,
                // JSON-encoded VARCHAR (session.labels) + a DEFAULT-reliant column
                // (session.source has DEFAULT 'claude', omitted here on purpose).
                `INSERT INTO session (id, labels) VALUES ('s1', '["spar"]');`,
                `SELECT id, source, labels, json_extract_string(labels, '$[0]') FROM session WHERE id = 's1';`,
                // UTC contract: the writer normalizes to UTC before insert, so the
                // literal carries no offset - a plain TIMESTAMP. The instant must
                // survive the round trip unchanged.
                `INSERT INTO "commit" (id, sha, repo, ts) VALUES ('c1', 'deadbeef', 'ax', TIMESTAMP '2026-06-15 10:00:00');`,
                `SELECT epoch(ts) FROM "commit" WHERE id = 'c1';`,
                // JSON-encoded VARCHAR (P2-3 reverted): agent_def.skills is plain
                // VARCHAR holding a JSON array string, not a native LIST column.
                `INSERT INTO agent_def (id, name, scope, dir_path, skills, content_hash) VALUES ('a1', 'my-agent', 'user', '/x', '["skill-a","skill-b"]', 'hash1');`,
                `SELECT skills, json_extract_string(skills, '$[1]') FROM agent_def WHERE id = 'a1';`,
                // Polymorphic edge row (P1-1): concerns carries an explicit
                // in_table/out_table pair alongside in_id/out_id.
                `INSERT INTO concerns (id, in_id, out_id, in_table, out_table, kind) VALUES ('e1', 'tool1', 'skill1', 'tool_call', 'skill', 'test');`,
                `SELECT in_table, out_table FROM concerns WHERE id = 'e1';`,
            ].join("\n");
            const run = Bun.spawnSync([duckdb, "-batch", "-noheader", "-list", dbPath], {
                stdin: new TextEncoder().encode(`${script}\n`),
            });
            const stderr = new TextDecoder().decode(run.stderr);
            expect(stderr).toBe("");
            expect(run.exitCode).toBe(0);

            const lines = new TextDecoder()
                .decode(run.stdout)
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            expect(lines.length).toBe(4);

            const [sessionRow, commitEpoch, agentDefSkills, concernsEdge] = lines as [string, string, string, string];

            // DEFAULT-reliant column: source was never supplied on insert, so
            // DuckDB's `DEFAULT CURRENT_TIMESTAMP`-style column default (here a
            // literal string default) must have fired.
            const [id, source, labels, firstLabel] = sessionRow.split("|");
            expect(id).toBe("s1");
            expect(source).toBe("claude");
            expect(labels).toBe('["spar"]');
            expect(firstLabel).toBe("spar");

            // The UTC instant inserted (no offset in the literal) must come back
            // unchanged - 2026-06-15T10:00:00Z.
            const expectedEpoch = Date.UTC(2026, 5, 15, 10, 0, 0) / 1000;
            expect(Number(commitEpoch)).toBe(expectedEpoch);

            // skills is a plain VARCHAR carrying JSON text, not a native list -
            // DuckDB's json_extract_string proves it reads as JSON, not as a LIST.
            const [skillsRaw, secondSkill] = agentDefSkills.split("|");
            expect(skillsRaw).toBe('["skill-a","skill-b"]');
            expect(secondSkill).toBe("skill-b");

            expect(concernsEdge).toBe("tool_call|skill");
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
                console.log(
                    "SKIPPED: FTS check skipped - the fts extension could not be downloaded (offline)",
                );
                return;
            }
            expect(run.exitCode).toBe(0);
            expect(stdout).toContain("fts-ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
