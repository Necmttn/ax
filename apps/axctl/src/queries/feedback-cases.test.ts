import { describe, expect, test } from "bun:test";
import {
    ENFORCE_WORKTREE_CASE_KEY,
    buildEnforceWorktreeCandidateQuery,
    buildFeedbackCasePersistStatements,
    classifyEnforceWorktreeWindow,
} from "./feedback-cases.ts";

describe("feedback case backtests", () => {
    test("enforce-worktree candidate query is scoped by hook command and recency", () => {
        const sql = buildEnforceWorktreeCandidateQuery({ sinceDays: 7, tail: 25 });

        expect(sql).toContain("FROM hook_command_invocation");
        expect(sql).toContain("string::contains(command, 'enforce-worktree')");
        expect(sql).toContain("tool_call IS NOT NONE");
        expect(sql).toContain("ts >= time::now() - 7d");
        expect(sql).toContain("LIMIT 25");
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

    test("persist statements write generic case type and result tables", () => {
        const sql = buildFeedbackCasePersistStatements([
            {
                target_id: "hook_command_invocation:abc123",
                session: "session:`s1`",
                ts: "2026-05-19T00:00:00.000Z",
                hook_name: "PreToolUse:Bash",
                hook_command: "bash enforce-worktree.sh",
                provider_status: "blocking_error",
                trigger_seq: 10,
                trigger_command: "touch src/a.ts",
                status: "failed",
                reason: "no correction",
                window: [],
            },
        ], 3).join("\n");

        expect(sql).toContain(`UPSERT feedback_case_type:\`${ENFORCE_WORKTREE_CASE_KEY}\``);
        expect(sql).toContain("UPSERT feedback_case_result:");
        expect(sql).toContain("target: hook_command_invocation:abc123");
        expect(sql).toContain("rule_kind: \"deterministic\"");
    });
});
