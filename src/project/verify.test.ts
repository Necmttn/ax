import { describe, expect, test } from "bun:test";
import { deriveVerificationChecks } from "./verify.ts";
import type { GitState, ProjectStack } from "./types.ts";

const baseGit: GitState = {
    root: "/repo",
    cwd: "/repo",
    branch: "feature",
    head: "abc1234",
    dirty: true,
    changes: [],
};

const baseStack: ProjectStack = {
    package: {
        packageJsonPath: "/repo/package.json",
        packageManager: "bun@1.3.8",
        scripts: {
            typecheck: "tsc --noEmit",
            test: "bun test",
            lint: "oxlint .",
        },
        dependencies: ["effect"],
        devDependencies: ["typescript"],
    },
    signals: [],
    instructions: [],
};

describe("deriveVerificationChecks", () => {
    test("requires typecheck for TypeScript edits", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "src/cli/index.ts",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "typescript",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks[0]).toMatchObject({
            id: "typescript-typecheck",
            severity: "required",
            command: "bun run typecheck",
        });
    });

    test("flags package changes without lockfile changes", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "package.json",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "json",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks.map((check) => check.id)).toContain("package-lockfile");
    });

    test("adds Effect guidance when Effect source changed", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "src/lib/layers.ts",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "typescript",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks.map((check) => check.id)).toContain("effect-guidance");
    });
});
