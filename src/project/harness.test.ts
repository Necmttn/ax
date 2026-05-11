import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    buildGuidanceRevisions,
    buildHarnessDoctor,
    mainBranchLearning,
    scanGuidanceSources,
} from "./harness.ts";
import type { GitState } from "./types.ts";

describe("scanGuidanceSources", () => {
    test("finds repo-local guidance and produces revisions", async () => {
        const root = await mkdtemp(join(tmpdir(), "agentctl-harness-"));
        try {
            await writeFile(join(root, "AGENTS.md"), "Never edit main without approval.\n", "utf8");
            await mkdir(join(root, ".agents"), { recursive: true });

            const sources = await Effect.runPromise(scanGuidanceSources(root));
            const repoSources = sources.filter((source) => source.scope === "repository");

            expect(repoSources.map((source) => source.path)).toContain(join(root, "AGENTS.md"));
            expect(repoSources.some((source) => source.provider === "agents")).toBe(true);

            const revisions = await Effect.runPromise(buildGuidanceRevisions(repoSources));
            expect(revisions).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        sourcePath: join(root, "AGENTS.md"),
                        scope: "repository",
                        evidenceStrength: "untracked",
                    }),
                ]),
            );
            expect(revisions[0]?.contentHash).toMatch(/^[a-f0-9]{16}$/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("buildHarnessDoctor", () => {
    test("groups tooling by harness layer", () => {
        const findings = buildHarnessDoctor([
            { name: "rg", layer: "perception", source: "global-command", evidence: "rg on PATH" },
            { name: "typecheck", layer: "verification", source: "package-script", evidence: "tsc --noEmit" },
            { name: "test", layer: "verification", source: "package-script", evidence: "bun test" },
            { name: "git", layer: "boundary", source: "git", evidence: "repository root /repo" },
        ]);

        expect(findings.find((finding) => finding.layer === "verification")).toMatchObject({
            status: "strong",
            recommendation: null,
        });
        expect(findings.find((finding) => finding.layer === "representation")).toMatchObject({
            status: "weak",
        });
    });
});

describe("mainBranchLearning", () => {
    test("flags dirty non-doc work on main as branch-safety evidence", () => {
        const git: GitState = {
            root: "/repo",
            cwd: "/repo",
            branch: "main",
            head: "abc123",
            dirty: true,
            changes: [
                {
                    path: "src/app.ts",
                    status: "M",
                    staged: false,
                    unstaged: true,
                    untracked: false,
                    lang: "typescript",
                },
            ],
        };

        const candidate = mainBranchLearning(git, []);

        expect(candidate.title).toBe("Block main-branch edits in multi-agent projects");
        expect(candidate.harnessLayer).toBe("boundary");
        expect(candidate.risk).toEqual({ kind: "branch_safety", level: "high" });
        expect(candidate.confidence).toBe("medium");
        expect(candidate.evidenceSummary).toContain("current checkout has write-risk changes on main/master");
    });
});
