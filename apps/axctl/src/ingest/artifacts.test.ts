import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import {
    artifactRootsForOptions,
    classifyArtifactPath,
    discoverArtifactsDryRun as discoverArtifactsDryRunEffect,
} from "./artifacts.ts";
import type { ArtifactDiscoveryOptions, ArtifactDiscoveryDryRun, ArtifactSkipReason } from "./artifacts.ts";

const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

// Forced-dependency edit: run the now-Effect discovery against the REAL
// Bun-backed FileSystem + Path (the production layers) over the existing
// tmp-dir fixtures, so symlink/dir/file detection is exercised honestly.
const discoverArtifactsDryRun = (
    options: ArtifactDiscoveryOptions,
): Promise<ArtifactDiscoveryDryRun> =>
    Effect.runPromise(discoverArtifactsDryRunEffect(options).pipe(Effect.provide(BunFsLayer)));

describe("artifact discovery roots", () => {
    test("builds allowlisted project roots plus configured skill roots", async () => {
        const workspace = await makeTempDir();
        const skills = await makeTempDir();

        expect(artifactRootsForOptions({ workspaceRoot: workspace, skillRoots: [skills] })).toEqual([
            { kind: "planning", path: join(workspace, ".planning") },
            { kind: "claude_monitoring", path: join(workspace, ".claude", "monitoring") },
            { kind: "claude_workflows", path: join(workspace, ".claude", "workflows") },
            { kind: "superpowers_plans", path: join(workspace, "docs", "superpowers", "plans") },
            { kind: "skill_root", path: skills },
        ]);
    });
});

describe("classifyArtifactPath", () => {
    test("classifies only the supported artifact extensions for each root kind", () => {
        expect(classifyArtifactPath("/repo/.planning/STATE.md", "planning")).toBe(
            "planning_markdown",
        );
        expect(classifyArtifactPath("/repo/.planning/config.json", "planning")).toBe(
            "planning_data",
        );
        expect(classifyArtifactPath("/repo/.planning/todo.yaml", "planning")).toBe(
            "planning_data",
        );
        expect(classifyArtifactPath("/repo/.claude/monitoring/plans/rca.md", "claude_monitoring"))
            .toBe("claude_monitoring_markdown");
        expect(classifyArtifactPath("/repo/.claude/workflows/review.mjs", "claude_workflows"))
            .toBe("claude_workflow_script");
        expect(classifyArtifactPath("/repo/docs/superpowers/plans/plan.md", "superpowers_plans"))
            .toBe("superpowers_plan");
        expect(classifyArtifactPath("/skills/diagnose/SKILL.md", "skill_root")).toBe("skill");

        expect(classifyArtifactPath("/repo/.planning/image.png", "planning")).toBeNull();
        expect(classifyArtifactPath("/repo/.claude/workflows/readme.md", "claude_workflows"))
            .toBeNull();
        expect(classifyArtifactPath("/skills/diagnose/README.md", "skill_root")).toBeNull();
    });
});

describe("discoverArtifactsDryRun", () => {
    test("finds allowlisted planning, workflow, monitoring, superpowers, and skill artifacts", async () => {
        const workspace = await makeTempDir();
        const skillRoot = await makeTempDir();

        await writeText(workspace, ".planning/STATE.md", "# State\n");
        await writeText(workspace, ".planning/config.json", "{}\n");
        await writeText(workspace, ".planning/rough/progress.yml", "items: []\n");
        await writeText(workspace, ".claude/monitoring/plans/rca.md", "# RCA\n");
        await writeText(workspace, ".claude/workflows/review.ts", "export default {}\n");
        await writeText(workspace, "docs/superpowers/plans/ship.md", "# Plan\n");
        await writeText(skillRoot, "diagnose/SKILL.md", "---\nname: diagnose\n---\nBody\n");

        const dryRun = await discoverArtifactsDryRun({
            workspaceRoot: workspace,
            skillRoots: [skillRoot],
        });

        expect(labelsOf(dryRun.candidates)).toEqual([
            "planning:STATE.md",
            "planning:config.json",
            "planning:rough/progress.yml",
            "claude_monitoring:plans/rca.md",
            "claude_workflows:review.ts",
            "superpowers_plans:ship.md",
            "skill_root:diagnose/SKILL.md",
        ].sort());
        expect(dryRun.counts.found).toBe(7);
        expect(dryRun.counts.byKind).toMatchObject({
            planning_markdown: 1,
            planning_data: 2,
            claude_monitoring_markdown: 1,
            claude_workflow_script: 1,
            superpowers_plan: 1,
            skill: 1,
        });
    });

    test("does not scan broad project files outside allowlisted roots", async () => {
        const workspace = await makeTempDir();
        await writeText(workspace, "docs/ARCHITECTURE_EVOLUTION_PLAN.md", "# broad plan\n");
        await writeText(workspace, "random/SKILL.md", "# accidental skill\n");
        await writeText(workspace, ".planning/known.md", "# known\n");

        const dryRun = await discoverArtifactsDryRun({ workspaceRoot: workspace, skillRoots: [] });

        expect(labelsOf(dryRun.candidates)).toEqual(["planning:known.md"]);
    });

    test("ignores dependency dirs, git metadata, Claude worktrees, nested repos, and symlinks", async () => {
        const workspace = await makeTempDir();
        await writeText(workspace, ".planning/keep.md", "# keep\n");
        await writeText(workspace, ".planning/node_modules/pkg/skip.md", "# no\n");
        await writeText(workspace, ".planning/.git/config", "[core]\n");
        await writeText(workspace, ".planning/nested-repo/.git/config", "[core]\n");
        await writeText(workspace, ".planning/nested-repo/plan.md", "# no\n");
        await writeText(workspace, ".claude/worktrees/copy/.planning/skip.md", "# no\n");
        await mkdir(join(workspace, ".planning", "links"), { recursive: true });
        await symlink(
            join(workspace, ".planning", "keep.md"),
            join(workspace, ".planning", "links", "keep-link.md"),
        );

        const dryRun = await discoverArtifactsDryRun({ workspaceRoot: workspace });

        expect(labelsOf(dryRun.candidates)).toEqual(["planning:keep.md"]);
        expect(reasonsOf(dryRun.skipped)).toEqual(expect.arrayContaining([
            "ignored_dir",
            "nested_git_repo",
            "symlink",
        ]));
        expect(dryRun.counts.bySkipReason.ignored_dir).toBeGreaterThanOrEqual(2);
        expect(dryRun.counts.bySkipReason.nested_git_repo).toBe(1);
        expect(dryRun.counts.bySkipReason.symlink).toBe(1);
    });

    // Focused coverage for the lstat -> readLink rewrite: the old code used
    // `lstat` (no symlink-follow) to (a) skip symlink entries and (b) detect a
    // nested repo via a `.git` directory OR a `.git` *gitfile* (worktree). This
    // proves the readLink-first classification preserves both branches against
    // the real Bun FileSystem.
    test("readLink-based detection: skips symlinks, detects .git gitfile (worktree) and .git dir", async () => {
        const workspace = await makeTempDir();
        await writeText(workspace, ".planning/keep.md", "# keep\n");

        // (a) symlink to a regular file -> skipped as "symlink", not followed.
        await writeText(workspace, ".planning/target.md", "# target\n");
        await symlink(
            join(workspace, ".planning", "target.md"),
            join(workspace, ".planning", "link.md"),
        );

        // (b) worktree-style nested repo: `.git` is a regular FILE (gitfile).
        await writeText(workspace, ".planning/worktree-repo/.git", "gitdir: /elsewhere\n");
        await writeText(workspace, ".planning/worktree-repo/plan.md", "# no\n");

        // (c) classic nested repo: `.git` is a DIRECTORY.
        await writeText(workspace, ".planning/dir-repo/.git/config", "[core]\n");
        await writeText(workspace, ".planning/dir-repo/plan.md", "# no\n");

        const dryRun = await discoverArtifactsDryRun({ workspaceRoot: workspace });

        // Only the real files at the planning root survive; the symlink target
        // is a real file so it is a legitimate candidate, the symlink is not.
        expect(labelsOf(dryRun.candidates)).toEqual(["planning:keep.md", "planning:target.md"].sort());
        expect(dryRun.counts.bySkipReason.symlink).toBe(1);
        // Both the gitfile worktree and the .git-dir repo are detected.
        expect(dryRun.counts.bySkipReason.nested_git_repo).toBe(2);
    });

    test("skips binary files and files over the configured size limit", async () => {
        const workspace = await makeTempDir();
        await writeText(workspace, ".planning/small.md", "# ok\n");
        await writeFileAt(workspace, ".planning/blob.md", Buffer.from([0x23, 0x00, 0x01]));
        await writeText(workspace, ".planning/large.md", "x".repeat(32));

        const dryRun = await discoverArtifactsDryRun({
            workspaceRoot: workspace,
            maxFileBytes: 16,
        });

        expect(labelsOf(dryRun.candidates)).toEqual(["planning:small.md"]);
        expect(reasonFor(dryRun.skipped, "blob.md")).toBe("binary");
        expect(reasonFor(dryRun.skipped, "large.md")).toBe("too_large");
        expect(dryRun.counts.bySkipReason.binary).toBe(1);
        expect(dryRun.counts.bySkipReason.too_large).toBe(1);
    });

    test("reports missing allowlist roots without failing the dry run", async () => {
        const workspace = await makeTempDir();
        await writeText(workspace, ".planning/STATE.md", "# State\n");

        const dryRun = await discoverArtifactsDryRun({ workspaceRoot: workspace });

        expect(dryRun.counts.found).toBe(1);
        expect(dryRun.counts.bySkipReason.missing_root).toBe(3);
    });
});

async function makeTempDir(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "ax-artifacts-"));
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
    await writeFileAt(root, relativePath, content);
}

async function writeFileAt(
    root: string,
    relativePath: string,
    content: string | Buffer,
): Promise<void> {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
}

function labelsOf(
    items: readonly { readonly rootKind: string; readonly relativePath: string }[],
): string[] {
    return items.map((item) => `${item.rootKind}:${item.relativePath}`).sort();
}

function reasonsOf(items: readonly { readonly reason: ArtifactSkipReason }[]): ArtifactSkipReason[] {
    return items.map((item) => item.reason);
}

function reasonFor(
    items: readonly { readonly relativePath: string | null; readonly reason: ArtifactSkipReason }[],
    relativePath: string,
): ArtifactSkipReason | null {
    return items.find((item) => item.relativePath === relativePath)?.reason ?? null;
}
