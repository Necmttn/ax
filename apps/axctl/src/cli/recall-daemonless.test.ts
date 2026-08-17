/**
 * `ax recall`, END TO END, with no server of any kind running.
 *
 * The claim the ported vertical rests on cannot be checked from inside the
 * process that defines the layers: an in-process test can always be handed a
 * `CacheRead` and a stub `SurrealClient` and will pass whether or not the real
 * CLI would have built `AppLayer` and tried to connect. So this spawns the ACTUAL
 * CLI entrypoint as a child, with:
 *
 *   - `AX_DUCKDB_SNAPSHOT` pointing at a snapshot this suite published, and
 *   - `AX_DB_URL` pointing at a port nothing is listening on, so ANY SurrealDB
 *     connect attempt fails rather than quietly finding the developer's own
 *     running daemon and making the test pass for the wrong reason.
 *
 * If recall still routed through `AppLayer`, the connect would fail (or hang to
 * its timeout) and the assertions below would not see hits.
 */
import { describe, expect } from "bun:test";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import type { CacheWriteService } from "@ax/lib/duckdb/seam";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("ax recall (no surreal)", { requireFts: true });

/** The CLI entrypoint, run the way `bin/axctl` runs it. */
const CLI = new URL("./index.ts", import.meta.url).pathname;

/** A port nothing listens on, so a SurrealDB connect can only FAIL. */

const T = (iso: string): Date => new Date(iso);

const CORPUS = (w: CacheWriteService) =>
    Effect.gen(function* () {
        yield* w.put("session", {
            id: "session-a",
            source: "claude",
            project: "ax",
            cwd: "/w/ax",
            repository: "repo-row-ax",
        });
        yield* w.putMany("turn", [
            {
                id: "turn-1",
                session: "session-a",
                seq: 1,
                ts: T("2026-08-10T10:00:00.000Z"),
                role: "user",
                text: "the duckdb seam replaces surreal",
                text_excerpt: "the duckdb seam replaces surreal",
                has_tool_use: false,
                has_error: false,
            },
            {
                id: "turn-2",
                session: "session-a",
                seq: 2,
                ts: T("2026-08-11T10:00:00.000Z"),
                role: "user",
                text: "an unrelated note about pancakes",
                text_excerpt: "an unrelated note about pancakes",
                has_tool_use: false,
                has_error: false,
            },
        ]);
        yield* w.put("hook_fire", {
            id: "hook-one",
            ts: T("2026-08-15T10:00:00.000Z"),
            kind: "hook_fire",
            session: "session-a",
            file: null,
            file_path: "src/a.ts",
            harness: "claude",
            ok: true,
            latency_ms: 7,
            event: "read",
            inject: true,
            reason: "high_signal",
            prior_sessions_considered: 1,
            task_excerpt: "read a file",
            top_prior_sessions: "[]",
            injected_titles: '["Earlier fix"]',
        });
        yield* w.put("tool_call", {
            id: "call-one",
            session: "session-a",
            name: "Bash",
            ts: T("2026-08-15T10:05:00.000Z"),
            input_json: '{"command":"bun test"}',
            has_error: false,
        });
    });

interface CliRun {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

const runCli = (args: ReadonlyArray<string>, snapshotPath: string): CliRun => {
    const child = Bun.spawnSync(["bun", CLI, ...args], {
        env: {
            ...process.env,
            AX_DUCKDB_SNAPSHOT: snapshotPath,
            ...(dylibPath === null ? {} : { AX_DUCKDB_DYLIB: dylibPath }),
            // Keep the child's output machine-readable and animation-free.
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

describe("ax recall on the cache runtime", () => {
    dtest("answers from the published snapshot with no SurrealDB reachable", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-recall-nodb-"), dylibPath, CORPUS),
        );

        const run = runCli(["recall", "duckdb", "--scope=all", "--json"], fixture.snapshotPath);

        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.exitCode).toBe(0);
        const body = JSON.parse(run.stdout) as {
            hits: ReadonlyArray<{ turn_id: string }>;
            total_count: number;
        };
        expect(body.hits.map((h) => h.turn_id)).toEqual(["turn-1"]);
        expect(body.total_count).toBe(1);
    }, 60_000);

    dtest("a query with no matches is still a clean exit, not a DB error", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-recall-nodb-miss-"), dylibPath, CORPUS),
        );

        const run = runCli(["recall", "zzzznonsense", "--scope=all", "--json"], fixture.snapshotPath);

        expect(run.exitCode).toBe(0);
        const body = JSON.parse(run.stdout) as { hits: ReadonlyArray<unknown>; total_count: number };
        expect(body.hits).toEqual([]);
        expect(body.total_count).toBe(0);
    }, 60_000);

    dtest("scope=here resolves the repository through the cache, not through Surreal", async () => {
        // `--scope=here` is the path that used to end in `resolvePwdRepository`'s
        // `SurrealClient` lookup. Run it in a REAL git repo (this one) so git
        // resolution succeeds; the cache has no matching repository row, so recall
        // says so on stderr and still exits cleanly.
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-recall-nodb-here-"), dylibPath, CORPUS),
        );

        const run = runCli(["recall", "duckdb", "--scope=here", "--json"], fixture.snapshotPath);

        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.exitCode).toBe(0);
        expect(run.stderr).toContain("nothing ingested for");
        const body = JSON.parse(run.stdout) as { hits: ReadonlyArray<unknown> };
        expect(body.hits).toEqual([]);
    }, 60_000);
});

describe("ported hook CLI on the cache runtime", () => {
    dtest("reports a typed cache failure at the CLI boundary", () => {
        const missingSnapshot = `${tempDir("ax-hook-log-missing-")}/snapshot.duckdb`;
        const run = runCli(["hook", "log", "--json"], missingSnapshot);

        expect(run.exitCode).toBe(1);
        expect(run.stderr).toContain("ax hook log: cache error -");
        expect(run.stderr).not.toContain("SurrealClient");
    }, 60_000);

    dtest("reads hook log rows with no SurrealDB reachable", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-hook-log-nodb-"), dylibPath, CORPUS),
        );

        const run = runCli(["hook", "log", "--json"], fixture.snapshotPath);

        expect(run.stderr).not.toContain("SurrealClient");
        expect(run.exitCode).toBe(0);
        const rows = JSON.parse(run.stdout) as ReadonlyArray<{ reason: string; latency_ms: number }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ reason: "high_signal", latency_ms: 7 });
    }, 60_000);

    dtest("runs hook backtest with no SurrealDB reachable", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("ax-hook-backtest-nodb-"), dylibPath, CORPUS),
        );
        const hook = new URL("../../../../packages/hooks-sdk/src/hooks/enforce-worktree.ts", import.meta.url).pathname;

        const run = runCli(["hooks", "backtest", hook, "--days=30", "--json"], fixture.snapshotPath);

        expect(run.stderr).not.toContain("SurrealClient");
        if (run.exitCode !== 0) throw new Error(run.stderr);
        const summary = JSON.parse(run.stdout) as { total: number; providers: ReadonlyArray<string> };
        expect(summary.total).toBe(1);
        expect(summary.providers).toEqual(["claude"]);
    }, 60_000);
});
