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
});
