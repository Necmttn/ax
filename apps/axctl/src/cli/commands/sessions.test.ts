import { describe, expect, test } from "bun:test";
import { projectRootForHere } from "./sessions.ts";

describe("sessions command helpers", () => {
    test("projectRootForHere uses main checkout root for linked worktrees", () => {
        expect(projectRootForHere({
            repoRoot: "/repo/.claude/worktrees/issue-123",
            mainRepoRoot: "/repo",
        })).toBe("/repo");
    });

    test("projectRootForHere keeps the active checkout for normal repos", () => {
        expect(projectRootForHere({
            repoRoot: "/repo",
            mainRepoRoot: "/repo",
        })).toBe("/repo");
    });

    test("projectRootForHere keeps its own root for an external linked worktree", () => {
        // Worktree NOT nested under the main checkout: rolling up to mainRepoRoot
        // would drop this worktree's own sessions (cwd path-prefix filter).
        expect(projectRootForHere({
            repoRoot: "/tmp/ax-issue-123",
            mainRepoRoot: "/repo",
        })).toBe("/tmp/ax-issue-123");
    });

    test("projectRootForHere ignores a mis-derived (internal) main root", () => {
        // e.g. submodule `--git-common-dir` resolving to `.git/modules/<name>`.
        expect(projectRootForHere({
            repoRoot: "/repo",
            mainRepoRoot: "/repo/.git/modules/sub",
        })).toBe("/repo");
    });
});
