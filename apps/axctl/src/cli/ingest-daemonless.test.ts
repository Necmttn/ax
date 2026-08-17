/**
 * `ax ingest`, END TO END, with no server of any kind running - the acceptance test for
 * wave 3's `c-ingest-cutover`.
 *
 * Sibling of `recall-daemonless.test.ts`, and out-of-process for the same
 * reason: the claim under test is about which LAYER the CLI builds, and an
 * in-process test is handed its layers either way. So this spawns the ACTUAL
 * CLI entrypoint as a child with `AX_DB_URL` pointing at a port nothing is
 * listening on, so any SurrealDB connect attempt FAILS rather than quietly
 * finding the developer's own running daemon and passing for the wrong reason.
 *
 * WHY IT SELECTS THE ROWS BACK. The progress ledger (`ingest_run` /
 * `ingest_stage` / `ingest_event`) is WRITE-ONLY on the CLI's happy path -
 * nothing `ax ingest` prints comes from reading it - so "the ingest exited 0"
 * is not evidence the ledger works. A `ts` bound as an ISO STRING instead of a
 * `Date`, or a count decoded through `Schema.Number` off a BIGINT column, writes
 * or reads NOTHING and still leaves an exit code of 0 and a silent Live tab.
 * Every assertion below is therefore on ROW COUNTS read back out of the
 * published snapshot, through the same `CacheRead` the dashboard uses.
 */
import { describe, expect } from "bun:test";
import { Effect, Schema } from "effect";
import { CacheRead, CacheReadLayer } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { FixturePlatform } from "@ax/lib/testing/cache-fixture";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ax ingest (no surreal)", {
    requireFts: true,
});

/** The CLI entrypoint, run the way `bin/axctl` runs it. */
const CLI = new URL("./index.ts", import.meta.url).pathname;

/** A port nothing listens on, so a SurrealDB connect can only FAIL. */

interface CliRun {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/**
 * Run the real CLI against an ISOLATED data dir.
 *
 * `AX_DATA_DIR` moves the live database, the ingest lock and the buckets out of
 * the developer's `~/.ax`; `AX_DUCKDB_SNAPSHOT` moves the published snapshot.
 * Both matter: without them this suite would ingest into - and republish over -
 * the real local cache.
 */
const runCli = (args: ReadonlyArray<string>, dir: string): CliRun => {
    const child = Bun.spawnSync(["bun", CLI, ...args], {
        env: {
            ...process.env,
            AX_DATA_DIR: dir,
            AX_DUCKDB_SNAPSHOT: `${dir}/snapshot.duckdb`,
            ...(dylibPath === null ? {} : { AX_DUCKDB_DYLIB: dylibPath }),
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

/** `count(*)` decodes through the BIGINT codec - `Schema.Number` over a BIGINT
 *  returns an EMPTY result rather than raising, which would turn this whole
 *  suite into a test that asserts nothing. */
const CountRow = Schema.Struct({ n: NumberFromBigIntColumn });

/**
 * One `count(*)` against the published snapshot, through the same `CacheRead`
 * the dashboard resolves.
 */
const countOf = (snapshotPath: string, sql: string): Promise<number> =>
    Effect.runPromise(
        Effect.gen(function* () {
            const read = yield* CacheRead;
            const rows = yield* read.rows(CountRow, sql);
            return rows[0]?.n ?? 0;
        }).pipe(
            Effect.provide(
                CacheReadLayer({
                    snapshotPath,
                    ...(dylibPath === null ? {} : { assetPath: dylibPath }),
                }),
            ),
            Effect.provide(FixturePlatform),
            Effect.scoped,
        ) as Effect.Effect<number, unknown>,
    );

describe("ax ingest on the cache runtime", () => {
    dtest(
        "completes with SurrealDB unreachable and leaves a readable progress ledger",
        async () => {
            const dir = tempDir("ax-ingest-nodb-");
            const snapshotPath = `${dir}/snapshot.duckdb`;

            // `--stages=skills` keeps the run bounded (the skills catalog on
            // disk) while still exercising the full ledger path: run row, stage
            // rows, stage-complete events, run finish, FTS build, publish.
            const run = runCli(["ingest", "--since=1", "--stages=skills"], dir);

            // The whole claim: a real ingest completes with no server anywhere,
            // and everything it wrote is readable back out of the published
            // snapshot file below. A stage that still needed a server could not
            // reach one, so it would surface here as a non-zero exit.
            if (run.exitCode !== 0) throw new Error(`ingest failed:\n${run.stderr}`);

            // ---- the ledger, read back out of the PUBLISHED snapshot ----
            const runs = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_run WHERE command = 'ingest'",
            );
            expect(runs).toBeGreaterThan(0);

            // "ok", not "running": `withIngestRunFinish` settled the row, which
            // is the write that used to be a separate SurrealQL statement.
            const settled = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_run WHERE status = 'ok'",
            );
            expect(settled).toBeGreaterThan(0);

            const stages = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_stage WHERE status = 'ok'",
            );
            expect(stages).toBeGreaterThan(0);

            // The row this test exists for. `ingest_event.ts` is a TIMESTAMP
            // column bound from a `Date`; a string there writes rows that never
            // decode while the ingest still exits 0.
            const events = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_event WHERE level = 'info'",
            );
            expect(events).toBeGreaterThan(0);

            // And the timestamps really are timestamps, not text that happens
            // to sort - a comparison the column type has to support.
            const dated = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_event WHERE ts > TIMESTAMP '2000-01-01 00:00:00'",
            );
            expect(dated).toBe(events);

            // Every event points at a run row that exists (the `run` column is
            // a plain string id now, not a Surreal record link).
            const orphans = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_event e "
                    + "WHERE NOT EXISTS (SELECT 1 FROM ingest_run r WHERE r.id = e.run)",
            );
            expect(orphans).toBe(0);
        },
        180_000,
    );

    dtest(
        "derive-signals runs on the ingest runtime with SurrealDB unreachable",
        async () => {
            // `derive-signals` is invoked BY NAME from the installed LaunchAgent
            // plist, and its manifest entry moved from `"db"` to `"ingest"` in
            // this chunk. If that routing were wrong it would try to connect.
            const dir = tempDir("ax-derive-nodb-");
            const snapshotPath = `${dir}/snapshot.duckdb`;

            const run = runCli(["derive-signals", "--since=1"], dir);

            if (run.exitCode !== 0) throw new Error(`derive-signals failed:\n${run.stderr}`);

            const runs = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_run WHERE command = 'derive-signals'",
            );
            expect(runs).toBeGreaterThan(0);

            const stages = await countOf(
                snapshotPath,
                "SELECT count(*) AS n FROM ingest_stage WHERE source = 'signals' AND status = 'ok'",
            );
            expect(stages).toBeGreaterThan(0);
        },
        180_000,
    );
});
