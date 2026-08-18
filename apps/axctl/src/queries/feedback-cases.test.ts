import { describe, expect, test } from "bun:test";
import {
    buildEnforceWorktreeCandidateClause,
    classifyEnforceWorktreeWindow,
} from "./feedback-cases.ts";

describe("feedback case backtests", () => {
    test("enforce-worktree candidate query is scoped by hook command and recency", () => {
        const clause = buildEnforceWorktreeCandidateClause({ sinceDays: 7, tail: 25 });

        expect(clause.sql).toContain("FROM hook_command_invocation");
        expect(clause.sql).toContain("contains(command, 'enforce-worktree')");
        expect(clause.sql).toContain("tool_call IS NOT NULL");
        expect(clause.sql).toContain("AND ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP)");
        expect(clause.sql).toContain("LIMIT 25");
        expect(clause.params).toEqual([7]);
    });

    test("without --since, the candidate clause has no recency filter or param", () => {
        const clause = buildEnforceWorktreeCandidateClause({ tail: 10 });

        expect(clause.sql).not.toContain("ts >=");
        expect(clause.params).toEqual([]);
    });

    test("enforce-worktree case passes when the following window creates a worktree", () => {
        expect(
            classifyEnforceWorktreeWindow(
                { seq: 10, command_text: "touch src/a.ts" },
                [
                    { seq: 11, command_text: "git status --short" },
                    { seq: 12, command_text: "git worktree add .worktrees/feature -b feature" },
                ],
            ),
        ).toEqual({
            status: "passed",
            reason: "observed corrective worktree command at tool seq 12",
        });
    });

    test("enforce-worktree case fails when following commands do not correct course", () => {
        expect(
            classifyEnforceWorktreeWindow(
                { seq: 10, command_text: "touch src/a.ts" },
                [
                    { seq: 11, command_text: "git status --short" },
                    { seq: 12, command_text: "bun test" },
                ],
            ),
        ).toEqual({
            status: "failed",
            reason: "no worktree creation or worktree-path command appeared in the following tool calls",
        });
    });

});
