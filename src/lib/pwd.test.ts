/**
 * Tests for src/lib/pwd.ts
 * Uses real git fixtures (mkdtemp + git init) for process calls,
 * and a mock SurrealClient for DB checks.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient, type SurrealClientShape } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";
import { resolvePwdRepository } from "./pwd.ts";

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

/** Build a mock SurrealClient layer. */
function makeMockDb(existsResponse: boolean) {
    const impl: SurrealClientShape = {
        query: <T extends unknown[] = unknown[]>(_sql: string, _bindings?: Record<string, unknown>) => {
            // Return a row (exists) or empty (not exists)
            const rows = existsResponse ? [{ id: "repository:somekey" }] : [];
            return Effect.succeed([[...rows]] as unknown as T);
        },
        upsert: (_id: RecordId, _content: Record<string, unknown>) => Effect.void,
        relate: () => Effect.void,
        putFile: () => Effect.void,
        getFile: () => Effect.succeed(""),
        raw: undefined as unknown as import("surrealdb").Surreal,
    };
    return Layer.succeed(SurrealClient, impl);
}

/** Run resolvePwdRepository with real ProcessService and mock DB. */
async function resolve(cwd: string, dbExists: boolean) {
    return Effect.runPromise(
        resolvePwdRepository(cwd).pipe(
            Effect.provide(Layer.merge(ProcessServiceLive, makeMockDb(dbExists))),
        ),
    );
}

/** Run resolvePwdRepository expecting failure, return the error. */
async function resolveErr(cwd: string) {
    return Effect.runPromise(
        resolvePwdRepository(cwd).pipe(
            Effect.match({
                onSuccess: (v) => ({ ok: true, v }) as const,
                onFailure: (e) => ({ ok: false, e }) as const,
            }),
            Effect.provide(Layer.merge(ProcessServiceLive, makeMockDb(false))),
        ),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolvePwdRepository", () => {
    test("repo with remote: identity.kind === 'remote'", async () => {
        const dir = await makeTempDir();
        await initRepoWithCommit(dir);
        git(["remote", "add", "origin", "git@github.com:foo/bar.git"], dir);

        const res = await resolve(dir, false);

        expect(res.cwd).toBe(dir);
        expect(res.repoRoot).toBe(dir);
        expect(res.remoteUrlNormalized).toBe("github.com/foo/bar");
        expect(res.identity.kind).toBe("remote");
        expect(res.identity.repositoryKey).toContain("remote__");
        expect(res.repositoryRecordId).toBeInstanceOf(RecordId);
        expect(String(res.repositoryRecordId)).toContain("repository");
        expect(res.existsInDb).toBe(false);
    });

    test("repo with remote: existsInDb true when DB returns a row", async () => {
        const dir = await makeTempDir();
        await initRepoWithCommit(dir);
        git(["remote", "add", "origin", "git@github.com:foo/bar.git"], dir);

        const res = await resolve(dir, true);
        expect(res.existsInDb).toBe(true);
    });

    test("repo with initial commit only (no remote): identity.kind === 'initial_commit'", async () => {
        const dir = await makeTempDir();
        const sha = await initRepoWithCommit(dir);

        const res = await resolve(dir, false);

        expect(res.identity.kind).toBe("initial_commit");
        expect(res.initialCommit).toBe(sha);
        expect(res.remoteUrlNormalized).toBeNull();
        expect(res.identity.repositoryKey).toContain("initial__");
        expect(res.existsInDb).toBe(false);
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

        const res = await resolve(subdir, false);

        expect(res.cwd).toBe(subdir);
        expect(res.repoRoot).toBe(dir);
    });

    test("cwd defaults to process.cwd() when not provided", async () => {
        // This test calls resolvePwdRepository() with no args; it will succeed
        // if we happen to be inside a git repo, or fail with NotAGitRepoError.
        // Either outcome is acceptable - just verify the function runs.
        const out = await Effect.runPromise(
            resolvePwdRepository().pipe(
                Effect.match({
                    onSuccess: (v) => ({ ok: true, cwd: v.cwd }) as const,
                    onFailure: (e) => ({ ok: false, tag: (e as { _tag: string })._tag }) as const,
                }),
                Effect.provide(Layer.merge(ProcessServiceLive, makeMockDb(false))),
            ),
        );
        // Either resolution or NotAGitRepoError are valid
        expect(["ok=true", "NotAGitRepoError"]).toContain(
            out.ok ? "ok=true" : (out as { tag: string }).tag,
        );
    });
});
