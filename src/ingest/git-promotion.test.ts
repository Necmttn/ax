import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { detectPromotionPath } from "./git-promotion.ts";

async function git(repoPath: string, args: readonly string[]): Promise<string> {
    const proc = Bun.spawn(["git", "-C", repoPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
    }
    return stdout.trim();
}

async function createRepo(): Promise<string> {
    const repoPath = await mkdtemp(join(tmpdir(), "ax-git-promotion-"));
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await writeFile(join(repoPath, "README.md"), "initial\n");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    return repoPath;
}

describe("detectPromotionPath", () => {
    test("reports a commit already reachable from main as direct or merge promoted", async () => {
        const repoPath = await createRepo();
        try {
            await writeFile(join(repoPath, "direct.txt"), "direct\n");
            await git(repoPath, ["add", "direct.txt"]);
            await git(repoPath, ["commit", "-m", "direct on main"]);
            const commitSha = await git(repoPath, ["rev-parse", "HEAD"]);

            const result = await detectPromotionPath({ repoPath, commitSha });

            expect(result.reachedMain).toBe(true);
            expect(result.path).toBe("direct_or_merge");
            expect(result.confidence).toBe("high");
            expect(result.mainBranch).toBe("main");
            expect(result.evidence.some((line) => line.includes("merge-base --is-ancestor"))).toBe(true);
        } finally {
            await rm(repoPath, { recursive: true, force: true });
        }
    });

    test("reports a feature branch commit outside main as not promoted", async () => {
        const repoPath = await createRepo();
        try {
            await git(repoPath, ["checkout", "-b", "feature"]);
            await writeFile(join(repoPath, "feature.txt"), "feature\n");
            await git(repoPath, ["add", "feature.txt"]);
            await git(repoPath, ["commit", "-m", "feature only"]);
            const commitSha = await git(repoPath, ["rev-parse", "HEAD"]);

            const result = await detectPromotionPath({ repoPath, commitSha });

            expect(result.reachedMain).toBe(false);
            expect(result.path).toBe("not_promoted");
            expect(result.confidence).toBe("high");
            expect(result.mainBranch).toBe("main");
        } finally {
            await rm(repoPath, { recursive: true, force: true });
        }
    });

    test("reports a squash-equivalent patch on main as medium-confidence promoted", async () => {
        const repoPath = await createRepo();
        try {
            await git(repoPath, ["checkout", "-b", "feature"]);
            await writeFile(join(repoPath, "squashed.txt"), "same patch\n");
            await git(repoPath, ["add", "squashed.txt"]);
            await git(repoPath, ["commit", "-m", "feature patch"]);
            const commitSha = await git(repoPath, ["rev-parse", "HEAD"]);

            await git(repoPath, ["checkout", "main"]);
            await writeFile(join(repoPath, "squashed.txt"), "same patch\n");
            await git(repoPath, ["add", "squashed.txt"]);
            await git(repoPath, ["commit", "-m", "squash feature patch"]);

            const result = await detectPromotionPath({ repoPath, commitSha });

            expect(result.reachedMain).toBe(true);
            expect(result.path).toBe("squash_or_cherry_pick");
            expect(result.confidence).toBe("medium");
            expect(result.mainBranch).toBe("main");
            expect(result.evidence.some((line) => line.includes("git cherry"))).toBe(true);
        } finally {
            await rm(repoPath, { recursive: true, force: true });
        }
    });

    test("reports a multi-commit feature branch squashed into main as promoted", async () => {
        const repoPath = await createRepo();
        try {
            await git(repoPath, ["checkout", "-b", "feature"]);
            await writeFile(join(repoPath, "first.txt"), "first change\n");
            await git(repoPath, ["add", "first.txt"]);
            await git(repoPath, ["commit", "-m", "first feature change"]);
            await writeFile(join(repoPath, "second.txt"), "second change\n");
            await git(repoPath, ["add", "second.txt"]);
            await git(repoPath, ["commit", "-m", "second feature change"]);
            const commitSha = await git(repoPath, ["rev-parse", "HEAD"]);

            await git(repoPath, ["checkout", "main"]);
            await writeFile(join(repoPath, "first.txt"), "first change\n");
            await writeFile(join(repoPath, "second.txt"), "second change\n");
            await git(repoPath, ["add", "first.txt", "second.txt"]);
            await git(repoPath, ["commit", "-m", "squash feature branch"]);

            const result = await detectPromotionPath({ repoPath, commitSha });

            expect(result.reachedMain).toBe(true);
            expect(result.path).toBe("squash_or_cherry_pick");
            expect(result.confidence).toBe("medium");
            expect(result.mainBranch).toBe("main");
            expect(result.evidence.some((line) => line.includes("range patch-id"))).toBe(true);
        } finally {
            await rm(repoPath, { recursive: true, force: true });
        }
    });
});
