export interface DetectPromotionPathInput {
    repoPath: string;
    commitSha: string;
    mainBranch?: string;
}

export type PromotionPath =
    | "direct_or_merge"
    | "squash_or_cherry_pick"
    | "not_promoted"
    | "unknown";

export type PromotionConfidence = "high" | "medium" | "low";

export interface PromotionPathResult {
    reachedMain: boolean;
    path: PromotionPath;
    confidence: PromotionConfidence;
    mainBranch: string;
    evidence: readonly string[];
}

interface GitResult {
    stdout: string;
    stderr: string;
    code: number;
}

async function runGit(repoPath: string, args: readonly string[]): Promise<GitResult> {
    const proc = Bun.spawn(["git", "-C", repoPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
}

async function runGitWithInput(repoPath: string, args: readonly string[], input: string): Promise<GitResult> {
    const proc = Bun.spawn(["git", "-C", repoPath, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });
    proc.stdin.write(input);
    proc.stdin.end();
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
}

function summarize(result: GitResult): string {
    const output = result.stdout.trim() || result.stderr.trim();
    if (output.length === 0) return `exit ${result.code}`;
    return `exit ${result.code}: ${output}`;
}

function result(
    mainBranch: string,
    reachedMain: boolean,
    path: PromotionPath,
    confidence: PromotionConfidence,
    evidence: readonly string[],
): PromotionPathResult {
    return {
        reachedMain,
        path,
        confidence,
        mainBranch,
        evidence,
    };
}

function cherryLineForCommit(output: string, commitSha: string): string | null {
    const lines = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    return lines.find((line) => {
        const [, sha] = line.split(/\s+/, 2);
        return sha ? sha === commitSha || commitSha.startsWith(sha) || sha.startsWith(commitSha) : false;
    }) ?? null;
}

async function patchIdForGitOutput(
    repoPath: string,
    args: readonly string[],
): Promise<{ patchId: string | null; evidence: readonly string[]; failed: boolean }> {
    const evidence: string[] = [];
    const patch = await runGit(repoPath, args);
    evidence.push(`git ${args.join(" ")}: ${summarize(patch)}`);
    if (patch.code !== 0) {
        return { patchId: null, evidence, failed: true };
    }

    const patchId = await runGitWithInput(repoPath, ["patch-id", "--stable"], patch.stdout);
    evidence.push(`git ${args.join(" ")} | git patch-id --stable: ${summarize(patchId)}`);
    if (patchId.code !== 0) {
        return { patchId: null, evidence, failed: true };
    }

    const firstLine = patchId.stdout.trim().split("\n")[0]?.trim();
    return {
        patchId: firstLine?.split(/\s+/, 1)[0] ?? null,
        evidence,
        failed: false,
    };
}

async function detectSquashRange(
    repoPath: string,
    commitSha: string,
    mainBranch: string,
): Promise<{ promoted: boolean; evidence: readonly string[]; failed: boolean }> {
    const evidence: string[] = [];
    const mergeBase = await runGit(repoPath, ["merge-base", mainBranch, commitSha]);
    evidence.push(`git merge-base ${mainBranch} ${commitSha}: ${summarize(mergeBase)}`);
    if (mergeBase.code !== 0) {
        return { promoted: false, evidence, failed: true };
    }

    const baseSha = mergeBase.stdout.trim().split("\n")[0];
    if (!baseSha) {
        evidence.push("range patch-id skipped: merge-base produced no sha");
        return { promoted: false, evidence, failed: true };
    }

    const rangePatch = await patchIdForGitOutput(repoPath, ["diff", baseSha, commitSha]);
    evidence.push(...rangePatch.evidence);
    if (rangePatch.failed) {
        return { promoted: false, evidence, failed: true };
    }
    if (!rangePatch.patchId) {
        evidence.push("range patch-id skipped: feature range has no patch-id");
        return { promoted: false, evidence, failed: false };
    }
    evidence.push(`range patch-id ${baseSha}..${commitSha}: ${rangePatch.patchId}`);

    const candidates = await runGit(repoPath, ["rev-list", "--reverse", `${baseSha}..${mainBranch}`]);
    evidence.push(`git rev-list --reverse ${baseSha}..${mainBranch}: ${summarize(candidates)}`);
    if (candidates.code !== 0) {
        return { promoted: false, evidence, failed: true };
    }

    for (const candidateSha of candidates.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const candidatePatch = await patchIdForGitOutput(repoPath, ["show", "--format=", candidateSha]);
        evidence.push(...candidatePatch.evidence);
        if (candidatePatch.failed) {
            return { promoted: false, evidence, failed: true };
        }
        if (candidatePatch.patchId === rangePatch.patchId) {
            evidence.push(`range patch-id matched main commit ${candidateSha}`);
            return { promoted: true, evidence, failed: false };
        }
    }

    evidence.push("range patch-id did not match any main commit");
    return { promoted: false, evidence, failed: false };
}

export async function detectPromotionPath(input: DetectPromotionPathInput): Promise<PromotionPathResult> {
    const mainBranch = input.mainBranch ?? "main";
    const evidence: string[] = [];

    const commitCheck = await runGit(input.repoPath, ["rev-parse", "--verify", `${input.commitSha}^{commit}`]);
    evidence.push(`git rev-parse --verify ${input.commitSha}^{commit}: ${summarize(commitCheck)}`);
    if (commitCheck.code !== 0) {
        return result(mainBranch, false, "unknown", "low", evidence);
    }

    const mainCheck = await runGit(input.repoPath, ["rev-parse", "--verify", `${mainBranch}^{commit}`]);
    evidence.push(`git rev-parse --verify ${mainBranch}^{commit}: ${summarize(mainCheck)}`);
    if (mainCheck.code !== 0) {
        return result(mainBranch, false, "unknown", "low", evidence);
    }

    const ancestor = await runGit(input.repoPath, [
        "merge-base",
        "--is-ancestor",
        input.commitSha,
        mainBranch,
    ]);
    evidence.push(`git merge-base --is-ancestor ${input.commitSha} ${mainBranch}: ${summarize(ancestor)}`);
    if (ancestor.code === 0) {
        return result(mainBranch, true, "direct_or_merge", "high", evidence);
    }
    if (ancestor.code !== 1) {
        return result(mainBranch, false, "unknown", "low", evidence);
    }

    const cherry = await runGit(input.repoPath, ["cherry", mainBranch, input.commitSha]);
    evidence.push(`git cherry ${mainBranch} ${input.commitSha}: ${summarize(cherry)}`);
    if (cherry.code !== 0) {
        return result(mainBranch, false, "unknown", "low", evidence);
    }

    const line = cherryLineForCommit(cherry.stdout, input.commitSha);
    if (line?.startsWith("-")) {
        return result(mainBranch, true, "squash_or_cherry_pick", "medium", evidence);
    }

    const squashRange = await detectSquashRange(input.repoPath, input.commitSha, mainBranch);
    evidence.push(...squashRange.evidence);
    if (squashRange.failed) {
        return result(mainBranch, false, "unknown", "low", evidence);
    }
    if (squashRange.promoted) {
        return result(mainBranch, true, "squash_or_cherry_pick", "medium", evidence);
    }

    return result(mainBranch, false, "not_promoted", "high", evidence);
}
