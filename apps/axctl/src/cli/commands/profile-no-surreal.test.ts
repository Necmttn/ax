/**
 * `ax profile`, END TO END, with NO SurrealDB reachable.
 *
 * Mirrors `apps/axctl/src/cli/recall-no-surreal.test.ts`: spawns the ACTUAL
 * CLI entrypoint as a child, with `AX_DB_URL` pointing at a port nothing is
 * listening on, so any SurrealDB connect attempt can only fail or hang to its
 * timeout - a real crash mode, not something an in-process test with a stub
 * layer could observe.
 *
 * HONEST STATE (2026-08-17, wave-3 profile/queries.ts port): only
 * `ax profile interview submit` is actually SurrealDB-free today, and this
 * file proves exactly that - it does NOT claim `show`/`publish`/`widget`/bare
 * `interview` are ported, because they are not:
 *
 *   - `fetchWindowedInvocations` (profile/queries.ts) is the one remaining
 *     unported statement in this file's ownership. Porting it was tried and
 *     reverted this session (see queries.ts's port history) because
 *     `apps/axctl/src/team/team-profile.ts` imports it directly and that
 *     file's own tests only provide a SurrealClient mock, not CacheRead -
 *     porting it makes 9 unrelated tests fail with "Service not found:
 *     ax/CacheRead". Needs a coordinated port of team-profile.ts by its
 *     owner, out of scope here.
 *   - `fetchCostModels` (queries/cost-analytics.ts, a DIFFERENT wave-3
 *     chunk's file, not touched by this session) still resolves
 *     SurrealClient for its main query; only its optional pricing-catalog
 *     lookup reads CacheRead.
 *
 * Both are reached unconditionally on every `buildProfile` call (`ax profile
 * show`'s and therefore `publish`/`widget`/bare `interview`'s common path),
 * so those four commands genuinely still need a live SurrealDB today.
 * Live-verified: `AX_DB_URL="ws://127.0.0.1:1/rpc" ax profile show --json`
 * exits 1 after a 5s connect timeout with a `DbError`
 * ("daemon not reachable..."), not a clean CacheRead-only run. `ax
 * profile.ts`'s own runtime manifest (`resolveRuntime`/`axProfileRuntime`,
 * see profile-interview.test.ts) already tracks this split: `interview
 * submit` resolves to runtime "none"; `show`/`publish`/`interview` (bare)
 * resolve to "db".
 */
import { describe, expect, test } from "bun:test";

/** The CLI entrypoint, run the way `bin/axctl` runs it. */
const CLI = new URL("../index.ts", import.meta.url).pathname;

/** A port nothing listens on, so a SurrealDB connect can only FAIL. */
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

describe("ax profile show/publish/widget/interview are NOT yet SurrealDB-free", () => {
    // These pin the CURRENT, honest state (see file header) rather than
    // asserting a success this session did not earn. Once
    // fetchWindowedInvocations (this file's queries.ts) and fetchCostModels
    // (queries/cost-analytics.ts) are both ported, this whole describe block
    // should be deleted and `show`/`publish`/`widget`/`interview` folded into
    // real no-surreal coverage above.
    test("`ax profile show` still fails when SurrealDB is unreachable", () => {
        const run = runCli(["profile", "show", "--json"]);
        expect(run.exitCode).not.toBe(0);
        expect(run.stderr).toContain("DbError");
    }, 60_000);
});
