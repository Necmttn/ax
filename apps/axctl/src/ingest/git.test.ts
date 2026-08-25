import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, PlatformError, Schema } from "effect";
import { BunPath } from "@effect/platform-bun";
import { FixturePlatform, publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { layerTestFileSystem } from "@ax/lib/testing/test-filesystem";
import { cacheRow, tsParam } from "@ax/lib/duckdb/row";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import {
    buildSessionCheckoutWhere,
    buildSessionRepoWhere,
    deriveRepositoryDisplayName,
    nestedCheckoutPaths,
    ingestGit,
    isGitRepo,
    readRepoListFile,
    REPO_LIST_FILE,
} from "./git.ts";

async function git(repoPath: string, args: readonly string[]): Promise<string> {
    const proc = Bun.spawn(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    return stdout.trim();
}

async function createRepoWithOneCommit(): Promise<string> {
    const repoPath = await mkdtemp(join(tmpdir(), "ax-git-warm-produced-"));
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await writeFile(join(repoPath, "README.md"), "initial\n");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    return repoPath;
}

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("git ingest", { requireFts: true });

describe("git path derivation", () => {
    test("derives repository display name from remote before checkout path", () => {
        expect(deriveRepositoryDisplayName("github.com/Necmttn/ax", "/tmp/other")).toBe("ax");
        expect(deriveRepositoryDisplayName(null, "/Users/me/Projects/local-repo")).toBe("local-repo");
    });

    test("finds nested checkout roots under the parent checkout", () => {
        expect(nestedCheckoutPaths("/repo", ["/repo", "/repo/.claude/worktrees/a", "/other"]))
            .toEqual(["/repo/.claude/worktrees/a"]);
    });

    test("binds repository and checkout paths as parameters", () => {
        const repo = buildSessionRepoWhere("/repo/it's-main");
        expect(repo.sql).not.toContain("/repo");
        expect(repo.params).toEqual(["/repo/it's-main", "/repo/it's-main/%"]);

        const checkout = buildSessionCheckoutWhere("/repo", ["/repo/worktree"]);
        expect(checkout.sql).not.toContain("/repo");
        expect(checkout.params).toEqual(["/repo", "/repo/%", "/repo/worktree", "/repo/worktree/%"]);
    });
});

describe("git discovery best-effort tolerance", () => {
    const permissionDenied = (method: string, path: string) =>
        PlatformError.systemError({
            _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: path,
        });

    test("readRepoListFile recovers a permission error to an empty list", async () => {
        const out = await Effect.runPromise(
            readRepoListFile().pipe(Effect.provide(layerTestFileSystem(
                {}, { errors: { [REPO_LIST_FILE]: permissionDenied("readFileString", REPO_LIST_FILE) } },
            ))),
        );
        expect(out).toEqual([]);
    });

    test("isGitRepo recovers a permission error to false", async () => {
        const probePath = "/locked-repo/.git";
        const out = await Effect.runPromise(
            isGitRepo("/locked-repo").pipe(
                Effect.provide(Layer.merge(
                    layerTestFileSystem({}, { errors: { [probePath]: permissionDenied("exists", probePath) } }),
                    BunPath.layer,
                )),
            ),
        );
        expect(out).toBe(false);
    });
});

describe("git ingest on real DuckDB", () => {
    dtest("uses the requested repository path and writes its checkout", async () => {
        const repoRoot = process.cwd();
        let stats: unknown;
        let rows: readonly unknown[] = [];

        await runWithPlatform(publishCacheFixture(tempDir("ax-git-ingest-"), dylibPath, (write) =>
            Effect.gen(function* () {
                stats = yield* ingestGit(write, { repoPaths: [repoRoot], sinceDays: 1 }).pipe(
                    Effect.provide(FixturePlatform),
                );
                rows = yield* write.rows(
                    Schema.Struct({ root_path: Schema.String, checkout_count: Schema.Number }),
                    `SELECT r.root_path, count(c.id)::INTEGER AS checkout_count
                     FROM repository r
                     JOIN checkout c ON c.repository = r.id
                     GROUP BY r.root_path`,
                );
            }),
        ));

        expect(stats).toMatchObject({ repos: 1 });
        expect(rows).toEqual([{ root_path: repoRoot, checkout_count: 1 }]);
    });

    dtest("#684: correlates a session added after the watermark, on a warm (skipped) git run", async () => {
        const repoPath = await createRepoWithOneCommit();
        try {
            let coldStats: unknown;
            let warmStats: unknown;
            let expectedCommitId = "";
            let produced: readonly unknown[] = [];

            await runWithPlatform(publishCacheFixture(tempDir("ax-git-warm-produced-"), dylibPath, (write) =>
                Effect.gen(function* () {
                    // Cold run: establishes the repository/checkout/commit rows
                    // and the git watermark. No sessions exist yet.
                    coldStats = yield* ingestGit(write, { repoPaths: [repoPath], sinceDays: 1 }).pipe(
                        Effect.provide(FixturePlatform),
                    );

                    const commitRows = yield* write.rows(
                        Schema.Struct({ id: Schema.String, ts: TimestampColumn }),
                        "SELECT id, ts FROM commit LIMIT 1",
                    );
                    const commit = commitRows[0];
                    if (!commit) throw new Error("expected a persisted commit after the cold run");
                    expectedCommitId = commit.id;

                    // Commit identity is repository-wide. A canonical commit
                    // row can name another worktree checkout, so correlation
                    // must match its repository and the session checkout.
                    yield* write.exec("UPDATE commit SET checkout = ? WHERE id = ?", [
                        "another-checkout",
                        commit.id,
                    ]);

                    // A session added AFTER the cold run, whose window covers
                    // the commit's ts. It has no `checkout` yet - that gets
                    // set by the warm run's session-linking UPDATE, same as
                    // any newly-ingested session would.
                    const startedAt = new Date(commit.ts.getTime() - 60_000);
                    const endedAt = new Date(commit.ts.getTime() + 60_000);
                    yield* write.put("session", cacheRow({
                        id: "warm-session-684", cwd: repoPath, source: "claude",
                        started_at: tsParam(startedAt), ended_at: tsParam(endedAt),
                    }));

                    // Warm run: HEAD is unchanged, so the watermark must skip
                    // the (expensive) git history walk - but the new session
                    // still needs its `produced` edge to the existing commit.
                    warmStats = yield* ingestGit(write, { repoPaths: [repoPath], sinceDays: 1 }).pipe(
                        Effect.provide(FixturePlatform),
                    );

                    produced = yield* write.rows(
                        Schema.Struct({ in_id: Schema.String, out_id: Schema.String }),
                        "SELECT in_id, out_id FROM produced WHERE in_id = ?",
                        ["warm-session-684"],
                    );
                }),
            ));

            expect(coldStats).toMatchObject({ repos: 1, commits: 1 });
            // The fetch path stayed skipped: an unchanged HEAD yields no
            // freshly-walked commits on the warm run.
            expect(warmStats).toMatchObject({ repos: 1, commits: 0 });
            expect(produced).toEqual([{ in_id: "warm-session-684", out_id: expectedCommitId }]);
        } finally {
            await rm(repoPath, { recursive: true, force: true });
        }
    });
});
