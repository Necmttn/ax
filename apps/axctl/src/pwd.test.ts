/**
 * Tests for src/pwd.ts
 * Uses real git fixtures (mkdtemp + git init) for the git half, and a real
 * published DuckDB cache for the lookup half.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { ProcessServiceLive } from "@ax/lib/process";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { resolvePwdCacheRepository, resolvePwdIdentity, type PwdCacheResolution } from "./pwd.ts";

const { dylibPath, dtest } = await duckdbTestSetup("pwd cache resolver", { requireFts: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ax-pwd-test-"));
    // Resolve symlinks so comparisons with realpath-resolved cwd work on macOS
    // (where /var/folders is a symlink to /private/var/folders).
    const resolved = await realpath(dir);
    tempDirs.push(resolved);
    return resolved;
}

afterAll(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

/** Run a git command in a directory synchronously using Bun.spawnSync. */
function git(args: string[], cwd: string): void {
    const result = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "ignore",
        stderr: "ignore",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
            GIT_AUTHOR_DATE: "2024-01-01T00:00:00+00:00",
            GIT_COMMITTER_DATE: "2024-01-01T00:00:00+00:00",
        },
    });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode})`);
    }
}

/** Create a minimal git repo with one commit. */
async function initRepoWithCommit(dir: string): Promise<string> {
    git(["init", "-b", "main"], dir);
    await writeFile(join(dir, "README.md"), "# test\n");
    git(["add", "."], dir);
    git(["commit", "-m", "init"], dir);
    // Return initial commit sha
    const result = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "HEAD"], {
        cwd: dir,
        stdout: "pipe",
    });
    return new TextDecoder().decode(result.stdout).trim();
}

/** Run resolvePwdIdentity with real ProcessService. Touches no engine. */
async function resolve(cwd: string) {
    return Effect.runPromise(
        resolvePwdIdentity(cwd).pipe(
            Effect.provide(Layer.mergeAll(ProcessServiceLive, BunFileSystem.layer)),
        ),
    );
}

/** Run resolvePwdIdentity expecting failure, return the error. */
async function resolveErr(cwd: string) {
    return Effect.runPromise(
        resolvePwdIdentity(cwd).pipe(
            Effect.match({
                onSuccess: (v) => ({ ok: true, v }) as const,
                onFailure: (e) => ({ ok: false, e }) as const,
            }),
            Effect.provide(Layer.mergeAll(ProcessServiceLive, BunFileSystem.layer)),
        ),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePwdIdentity", () => {
    test("repo with remote: identity.kind === 'remote'", async () => {
        const dir = await makeTempDir();
        await initRepoWithCommit(dir);
        git(["remote", "add", "origin", "git@github.com:foo/bar.git"], dir);

        const res = await resolve(dir);

        expect(res.cwd).toBe(dir);
        expect(res.repoRoot).toBe(dir);
        expect(res.remoteUrlNormalized).toBe("github.com/foo/bar");
        // The RAW spelling is carried too, not just the normalized one: the git
        // ingest stage persists `repository.remote_url` raw, so a reader that
        // only had the normalized form could not match the column it queries
        // (`queries/repository-scope.ts`).
        expect(res.remoteUrl).toBe("git@github.com:foo/bar.git");
        expect(res.identity.kind).toBe("remote");
        expect(res.identity.repositoryKey).toContain("remote__");
    });

    test("repo with initial commit only (no remote): identity.kind === 'initial_commit'", async () => {
        const dir = await makeTempDir();
        const sha = await initRepoWithCommit(dir);

        const res = await resolve(dir);

        expect(res.identity.kind).toBe("initial_commit");
        expect(res.initialCommit).toBe(sha);
        expect(res.remoteUrlNormalized).toBeNull();
        expect(res.remoteUrl).toBeNull();
        expect(res.identity.repositoryKey).toContain("initial__");
    });

    test("non-git directory: NotAGitRepoError", async () => {
        const dir = await makeTempDir();
        // no git init - plain directory

        const out = await resolveErr(dir);

        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.e._tag).toBe("NotAGitRepoError");
        }
    });

    test("worktree subdir: repoRoot is parent, not subdir", async () => {
        const dir = await makeTempDir();
        await initRepoWithCommit(dir);
        const subdir = join(dir, "src");
        await mkdir(subdir, { recursive: true });

        const res = await resolve(subdir);

        expect(res.cwd).toBe(subdir);
        expect(res.repoRoot).toBe(dir);
    });

    test("linked worktree: repoRoot is checkout, mainRepoRoot is primary checkout", async () => {
        const dir = await makeTempDir();
        await initRepoWithCommit(dir);
        const worktree = `${dir}-feature`;
        tempDirs.push(worktree);

        git(["worktree", "add", "-b", "feature", worktree], dir);

        const res = await resolve(worktree);

        expect(res.repoRoot).toBe(worktree);
        expect(res.mainRepoRoot).toBe(dir);
    });

    test("cwd defaults to process.cwd() when not provided", async () => {
        // This test calls resolvePwdIdentity() with no args; it will succeed
        // if we happen to be inside a git repo, or fail with NotAGitRepoError.
        // Either outcome is acceptable - just verify the function runs.
        const out = await Effect.runPromise(
            resolvePwdIdentity().pipe(
                Effect.match({
                    onSuccess: (v) => ({ ok: true, cwd: v.cwd }) as const,
                    onFailure: (e) => ({ ok: false, tag: (e as { _tag: string })._tag }) as const,
                }),
                Effect.provide(Layer.mergeAll(ProcessServiceLive, BunFileSystem.layer)),
            ),
        );
        // Either resolution or NotAGitRepoError are valid
        expect(["ok=true", "NotAGitRepoError"]).toContain(
            out.ok ? "ok=true" : (out as { tag: string }).tag,
        );
    });
});

// ---------------------------------------------------------------------------
// The cache-side resolver (v2)
// ---------------------------------------------------------------------------

/**
 * `resolvePwdCacheRepository` is what every `--here` caller uses. It resolves
 * against a REAL published cache, because
 * the whole point is the LOOKUP - a constructed id would be guessing at a
 * content-hash recipe, and a mock would just confirm the guess.
 */
describe("resolvePwdCacheRepository", () => {
    const runOnCache = (cwd: string, snapshotPath: string) =>
        Effect.runPromise(
            resolvePwdCacheRepository(cwd).pipe(
                Effect.provide(
                    Layer.mergeAll(
                        ProcessServiceLive,
                        BunFileSystem.layer,
                        readFixture(snapshotPath, dylibPath),
                    ),
                ),
            ) as Effect.Effect<PwdCacheResolution, unknown>,
        );

    dtest("returns the cached repository ROW id, and the git identity with it", async () => {
        const dir = await makeTempDir();
        const initialCommit = await initRepoWithCommit(dir);
        const fixture = await runWithPlatform(
            publishCacheFixture(await makeTempDir(), dylibPath, (w) =>
                w.put("repository", {
                    id: "repo-row-fixture",
                    name: "fixture",
                    root_path: dir,
                    initial_commit: initialCommit,
                }),
            ),
        );

        const res = await runOnCache(dir, fixture.snapshotPath);

        expect(res.repositoryId).toBe("repo-row-fixture");
        // The git half is carried through untouched - callers need both.
        expect(res.repoRoot).toBe(dir);
        expect(res.initialCommit).toBe(initialCommit);
        expect(res.identity.kind).toBe("initial_commit");
    });

    dtest("a repository the cache has never seen is null, NOT a failure", async () => {
        // A caller scoping to "here" then honestly has zero rows to find, which
        // is what `--scope=all` exists for. Failing would make `ax <cmd> --here`
        // unusable on a repo that simply has not been ingested yet.
        const dir = await makeTempDir();
        await initRepoWithCommit(dir);
        const fixture = await runWithPlatform(
            publishCacheFixture(await makeTempDir(), dylibPath, () => Effect.void),
        );

        const res = await runOnCache(dir, fixture.snapshotPath);

        expect(res.repositoryId).toBeNull();
        expect(res.repoRoot).toBe(dir);
    });

    dtest("a directory outside any git repo still fails as NotAGitRepoError", async () => {
        const dir = await makeTempDir();
        const fixture = await runWithPlatform(
            publishCacheFixture(await makeTempDir(), dylibPath, () => Effect.void),
        );

        const out = await Effect.runPromise(
            resolvePwdCacheRepository(dir).pipe(
                Effect.match({
                    onSuccess: () => "resolved",
                    onFailure: (e) => (e as { _tag: string })._tag,
                }),
                Effect.provide(
                    Layer.mergeAll(
                        ProcessServiceLive,
                        BunFileSystem.layer,
                        readFixture(fixture.snapshotPath, dylibPath),
                    ),
                ),
            ) as Effect.Effect<string>,
        );

        expect(out).toBe("NotAGitRepoError");
    });
});
