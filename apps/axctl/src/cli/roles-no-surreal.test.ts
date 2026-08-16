/**
 * `ax roles`, END TO END, with NO SurrealDB reachable and NO DuckDB snapshot.
 *
 * The sibling of recall-no-surreal.test.ts, and the acceptance signal for the
 * judgment half of the v2 split. An in-process test cannot check this: it is
 * handed whatever layers it asks for and passes either way. So this spawns the
 * ACTUAL CLI entrypoint as a child with
 *
 *   - `AX_SIDECAR_PATH` pointing at a sidecar this suite wrote,
 *   - `AX_DB_URL` pointing at a port nothing listens on, so any SurrealDB connect
 *     FAILS rather than quietly finding the developer's own running daemon and
 *     passing for the wrong reason, and
 *   - `AX_DUCKDB_SNAPSHOT` pointing at a file that does not exist.
 *
 * The missing snapshot is deliberate and is the extra claim this suite makes over
 * recall's. `ax roles` is PURE JUDGMENT - the role vocabulary and the tag counts
 * both live in the sidecar - so it must answer on a machine that has never run an
 * ingest. If the command touched the cache for any part of its answer, the
 * missing snapshot would surface as `CacheUnavailableError` and this would fail.
 *
 * No dylib gate, for the same reason: nothing here opens DuckDB.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roleRowId } from "@ax/lib/stable-id";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";

/** The CLI entrypoint, run the way `bin/axctl` runs it. */
const CLI = Bun.fileURLToPath(new URL("./index.ts", import.meta.url));

/** A port nothing listens on, so a SurrealDB connect can only FAIL. */
const DEAD_DB_URL = "ws://127.0.0.1:1/rpc";

interface CliRun {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

const runCli = (args: ReadonlyArray<string>, sidecarPath: string, dir: string): CliRun => {
    const child = Bun.spawnSync(["bun", CLI, ...args], {
        env: {
            ...process.env,
            AX_SIDECAR_PATH: sidecarPath,
            // A snapshot that does not exist: any cache read would fail loudly.
            AX_DUCKDB_SNAPSHOT: join(dir, "there-is-no-snapshot.duckdb"),
            AX_DB_URL: DEAD_DB_URL,
            AX_PROGRESS: "off",
            NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: child.exitCode,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString(),
    };
};

/** Two roles, one tagged twice and one tagged once, written straight into a
 *  sidecar file - no ax code involved, so this fixture cannot mask a bug in the
 *  write path the way an `ax skills tag` call would. */
const seedSidecar = (sidecarPath: string): void => {
    const db = new Database(sidecarPath, { create: true });
    db.exec(SIDECAR_SCHEMA_SQL);
    const verification = roleRowId("verification");
    const framing = roleRowId("framing");
    db.exec(`
        INSERT INTO role (id, name, weight) VALUES
            ('${verification}', 'verification', 2.0),
            ('${framing}', 'framing', 1.0);
        INSERT INTO plays_role (id, in_id, out_id, source, confidence) VALUES
            ('pr1', 'skill:tdd', '${verification}', 'user', 1.0),
            ('pr2', 'skill:brainstorming', '${verification}', 'frontmatter', 0.4),
            ('pr3', 'skill:brainstorming', '${framing}', 'user', 1.0);
    `);
    db.close();
};

describe("ax roles on the cache runtime", () => {
    test("answers from the sidecar with no SurrealDB and no snapshot", () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-roles-nodb-"));
        try {
            const sidecarPath = join(dir, "judgment.sqlite");
            seedSidecar(sidecarPath);

            const run = runCli(["roles", "--json"], sidecarPath, dir);

            expect(run.stderr).not.toContain("SurrealClient");
            expect(run.stderr).not.toContain("CacheUnavailableError");
            expect(run.exitCode).toBe(0);
            const body = JSON.parse(run.stdout) as {
                rows: ReadonlyArray<{ name: string; weight: number; skill_count: number }>;
            };
            expect(body.rows.map((r) => [r.name, r.skill_count])).toEqual([
                ["verification", 2],
                ["framing", 1],
            ]);
            expect(body.rows[0]?.weight).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);

    test("an empty sidecar is a clean exit, not a missing-database error", () => {
        // The first-run shape: the sidecar file does not exist at all yet. The
        // seam creates it, the DDL applies, and the answer is honestly empty.
        const dir = mkdtempSync(join(tmpdir(), "ax-roles-nodb-empty-"));
        try {
            const run = runCli(["roles", "--json"], join(dir, "not-created-yet.sqlite"), dir);

            expect(run.exitCode).toBe(0);
            const body = JSON.parse(run.stdout) as { rows: ReadonlyArray<unknown> };
            expect(body.rows).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
