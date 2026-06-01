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

    test("requires test run for test-file changes", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "src/project/verify.test.ts",
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

        expect(checks).toContainEqual(
            expect.objectContaining({
                id: "tests-run",
                severity: "required",
                command: "bun run test",
            }),
        );
    });

    test("recommends lint for lintable source changes", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "src/cli/index.js",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "javascript",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks).toContainEqual(
            expect.objectContaining({
                id: "lint",
                severity: "recommended",
                command: "bun run lint",
            }),
        );
    });

    test("recommends schema smoke check for schema changes", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "schema/main.surql",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "surql",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks).toContainEqual(
            expect.objectContaining({
                id: "schema-smoke",
                severity: "recommended",
                command: null,
            }),
        );
    });

    test("suggests diff review for dirty changes with no matched heuristic", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "README.md",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "markdown",
                    },
                ],
            },
            stack: baseStack,
        });

        expect(checks).toEqual([
            expect.objectContaining({
                id: "review-diff",
                severity: "info",
                command: "git diff --stat",
            }),
        ]);
    });

    test("uses pnpm commands when package manager is pnpm", () => {
        const checks = deriveVerificationChecks({
            git: {
                ...baseGit,
                changes: [
                    {
                        path: "src/project/verify.test.ts",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "typescript",
                    },
                    {
                        path: "schema/main.surql",
                        status: "M",
                        staged: false,
                        unstaged: true,
                        untracked: false,
                        lang: "surql",
                    },
                ],
            },
            stack: {
                ...baseStack,
                package: {
                    ...baseStack.package,
                    packageManager: "pnpm@10.0.0",
                    scripts: {
                        ...baseStack.package.scripts,
                        "db:schema": "surreal import schema/main.surql",
                    },
                },
            },
        });

        const commandsById = new Map(checks.map((check) => [check.id, check.command]));

        expect(commandsById.get("typescript-typecheck")).toBe("pnpm run typecheck");
        expect(commandsById.get("tests-run")).toBe("pnpm run test");
        expect(commandsById.get("lint")).toBe("pnpm run lint");
        expect(commandsById.get("schema-smoke")).toBe("pnpm run db:schema");
    });
});
