/**
 * Tests for src/lib/git-window.ts
 * Uses real git fixtures (mkdtemp + git init) for process calls.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { ProcessServiceLive } from "./process.ts";
import { findCommitWindow } from "./git-window.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ax-git-window-test-"));
    tempDirs.push(dir);
    return dir;
}

afterAll(async () => {
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(args: string[], cwd: string, extraEnv?: Record<string, string>): string {
    const result = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...GIT_ENV, ...extraEnv },
    });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed (exit ${result.exitCode}): ${new TextDecoder().decode(result.stderr)}`);
    }
    return new TextDecoder().decode(result.stdout).trim();
}

/** Create repo with N commits. Returns array of SHAs in order (oldest first). */
async function initRepoWithCommits(dir: string, n: number): Promise<string[]> {
    git(["init", "-b", "main"], dir);
    const shas: string[] = [];
    for (let i = 0; i < n; i++) {
        await writeFile(join(dir, `file${i}.txt`), `content ${i}\n`);
        git(["add", "."], dir, {
            GIT_AUTHOR_DATE: `2024-01-0${i + 1}T12:00:00+00:00`,
            GIT_COMMITTER_DATE: `2024-01-0${i + 1}T12:00:00+00:00`,
        });
        git(["commit", "-m", `commit ${i}`], dir, {
            GIT_AUTHOR_DATE: `2024-01-0${i + 1}T12:00:00+00:00`,
            GIT_COMMITTER_DATE: `2024-01-0${i + 1}T12:00:00+00:00`,
        });
        const sha = git(["rev-parse", "HEAD"], dir);
        shas.push(sha);
    }
    return shas;
}

async function runFindCommitWindow(repoRoot: string, sha: string) {
    return Effect.runPromise(
        findCommitWindow(repoRoot, sha).pipe(
            Effect.provide(ProcessServiceLive),
        ),
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findCommitWindow", () => {
    test("second commit returns window [predecessor, commit]", async () => {
        const dir = await makeTempDir();
        const [_firstSha, secondSha] = await initRepoWithCommits(dir, 2);

        const result = await runFindCommitWindow(dir, secondSha!);

        expect(result.kind).toBe("window");
        if (result.kind === "window") {
            expect(result.from).toBeInstanceOf(Date);
            expect(result.to).toBeInstanceOf(Date);
            // predecessor (commit 0) is Jan 1; commit 1 is Jan 2
            expect(result.from.getTime()).toBeLessThan(result.to.getTime());
            expect(result.to.getFullYear()).toBe(2024);
        }
    });

    test("root commit (no parent) returns orphan", async () => {
        const dir = await makeTempDir();
        const [firstSha] = await initRepoWithCommits(dir, 1);

        const result = await runFindCommitWindow(dir, firstSha!);

        expect(result.kind).toBe("orphan");
        if (result.kind === "orphan") {
            expect(result.commitTs).toBeInstanceOf(Date);
            expect(result.commitTs.getFullYear()).toBe(2024);
        }
    });

    test("unknown sha returns not_found", async () => {
        const dir = await makeTempDir();
        await initRepoWithCommits(dir, 1);

        const result = await runFindCommitWindow(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

        expect(result.kind).toBe("not_found");
    });

    test("HEAD resolves correctly as a ref", async () => {
        const dir = await makeTempDir();
        const [_first, _second] = await initRepoWithCommits(dir, 2);

        const result = await runFindCommitWindow(dir, "HEAD");

        // HEAD is the second commit - should have a predecessor
        expect(result.kind).toBe("window");
    });
});
