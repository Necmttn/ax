/**
 * `ax profile`, END TO END, with no server of any kind running.
 *
 * Mirrors `apps/axctl/src/cli/recall-daemonless.test.ts`: spawns the ACTUAL
 * CLI entrypoint as a child, with `AX_DB_URL` pointing at a port nothing is
 * listening on (defensive - no current code path reads it) and no server of
 * any kind running - a real crash mode, not something an in-process test
 * with a stub layer could observe.
 *
 * `ax profile interview submit` needs no data layer at all; `show`/`publish`/
 * `widget`/bare `interview` read the published snapshot through `CacheRead`
 * and nothing else. The failure mode with no engine anywhere is a
 * `CacheUnavailableError` naming the missing snapshot, not a dead-daemon
 * connect timeout.
 */
import { describe, expect, test } from "bun:test";

/** The CLI entrypoint, run the way `bin/axctl` runs it. */
const CLI = new URL("../index.ts", import.meta.url).pathname;

/** A port nothing listens on - defensive, since no current code path reads
 *  `AX_DB_URL`, but keeps the env var harmless if that changes. */
const DEAD_DB_URL = "ws://127.0.0.1:1/rpc";

/** A path nothing publishes to, so a CacheRead open can only FAIL too. */
const DEAD_SNAPSHOT = "/tmp/does-not-exist-ax-profile-nodb.duckdb";

interface CliRun {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

const runCli = (args: ReadonlyArray<string>, extraEnv: Record<string, string> = {}): CliRun => {
    const child = Bun.spawnSync(["bun", CLI, ...args], {
        env: {
            ...process.env,
            AX_DB_URL: DEAD_DB_URL,
            AX_DUCKDB_SNAPSHOT: DEAD_SNAPSHOT,
            AX_PROGRESS: "off",
            NO_COLOR: "1",
            ...extraEnv,
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

const tmpHome = () => `/tmp/ax-profile-nodb-home-${process.pid}-${Math.random().toString(36).slice(2)}`;

describe("ax profile interview submit on the cache runtime", () => {
    test("validates + writes highlights with no SurrealDB and no DuckDB snapshot reachable", async () => {
        const home = tmpHome();
        const inputPath = `${home}/highlights-input.json`;
        await Bun.write(
            inputPath,
            JSON.stringify({ v: 1, authored_at: "2026-06-17T00:00:00Z", taste: "ship clean" }),
        );

        const run = runCli(["profile", "interview", "submit", "--file", inputPath], { HOME: home });

        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.stderr).not.toContain("daemon not reachable");
        expect(run.exitCode).toBe(0);
        const written = await Bun.file(`${home}/.ax/profile-highlights.json`).json() as { taste?: string };
        expect(written.taste).toBe("ship clean");

        Bun.spawnSync(["rm", "-rf", home]);
    }, 60_000);

    test("rejects a bad shape without ever needing a DB, and writes nothing", async () => {
        const home = tmpHome();
        const inputPath = `${home}/highlights-input.json`;
        await Bun.write(inputPath, JSON.stringify({ taste: 5 })); // taste must be a string

        const run = runCli(["profile", "interview", "submit", "--file", inputPath], { HOME: home });

        // /dev/null decodes to nothing usable - the CLI should fail on shape,
        // not on a DB connect (which would show up as a DbError/timeout).
        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.stderr).not.toContain("daemon not reachable");
        expect(run.exitCode).not.toBe(0);
        expect(await Bun.file(`${home}/.ax/profile-highlights.json`).exists()).toBe(false);

        Bun.spawnSync(["rm", "-rf", home]);
    }, 60_000);
});

describe("ax profile show is SurrealDB-free", () => {
    test("with no engine reachable it names the MISSING SNAPSHOT, not a dead daemon", () => {
        const run = runCli(["profile", "show", "--json"]);
        // It still fails - `DEAD_SNAPSHOT` does not exist - but the failure is
        // about the cache. The distinction is the whole point: a `DbError`
        // here would mean something on this path still opens a live database
        // connection.
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toContain("CacheUnavailableError");
        expect(run.stderr).not.toContain("DbError");
        expect(run.stderr).not.toContain("daemon not reachable");
        expect(run.stderr).not.toContain("SurrealClient");
    }, 60_000);
});
