import { describe, expect, test } from "bun:test";
import {
    deriveDiagnosticsFromToolCalls,
    deriveFrictionFromToolCalls,
    deriveRecommendationFromFriction,
    shouldDeriveAllTimeSkillPairs,
} from "./derive-signals.ts";

describe("evidence derivation helpers", () => {
    test("failed command derives tool_error friction with command target name", () => {
        const events = deriveFrictionFromToolCalls([
            {
                id: "tool_call:session__call_1",
                session: "session:abc",
                turn: "turn:abc_7",
                name: "exec_command",
                command_norm: "bun test",
                output_excerpt: "1 fail, 2 pass",
                error_text: "Expected 1 failure",
                exit_code: 1,
                has_error: true,
                ts: "2026-05-09T10:00:00.000Z",
            },
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: "tool_error__session__call_1",
            kind: "tool_error",
            sessionId: "abc",
            turnKey: "abc_7",
            targetType: "tool",
            targetName: "bun test",
            text: "Expected 1 failure",
            ts: "2026-05-09T10:00:00.000Z",
        });
        expect(events[0]?.labels).toMatchObject({
            targetType: "tool",
            targetName: "bun test",
        });
        expect(events[0]?.metrics).toMatchObject({ exitCode: 1 });
    });

    test("failed command derives diagnostic_event shape", () => {
        const events = deriveDiagnosticsFromToolCalls([
            {
                id: "tool_call:session__call_2",
                session: "session:abc",
                turn: "turn:abc_8",
                name: "exec_command",
                command_norm: "bun test",
                output_excerpt: "TypeScript error",
                exit_code: 1,
                status: "error",
                has_error: true,
                ts: "2026-05-09T10:01:00.000Z",
            },
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            key: "tool_failure__session__call_2",
            kind: "tool_failure",
            status: "error",
            text: "TypeScript error",
            targetType: "tool",
            targetName: "bun test",
        });
    });

    test("repeated checkout corrections derive just-in-time guidance recommendation", () => {
        const recommendation = deriveRecommendationFromFriction([
            {
                key: "correction-1",
                kind: "user_correction",
                text: "Actually use the current checkout before editing.",
                labels: { repository: "repository:ax", scope: "repository" },
                ts: "2026-05-09T10:00:00.000Z",
            },
            {
                key: "correction-2",
                kind: "user_correction",
                text: "Wrong checkout, this is the worktree for the branch.",
                labels: { repository: "repository:ax", scope: "repository" },
                ts: "2026-05-09T10:05:00.000Z",
            },
            {
                key: "correction-3",
                kind: "user_correction",
                text: "Stop and check the checkout path first.",
                labels: { repository: "repository:ax", scope: "repository" },
                ts: "2026-05-09T10:10:00.000Z",
            },
        ]);

        expect(recommendation).toMatchObject({
            key: "jit_checkout_guidance__repository__ax",
            subjectType: "repository",
            subjectId: "repository:ax",
            status: "open",
        });
        expect(recommendation?.text).toContain("checkout");
        expect(recommendation?.rationale).toContain("3 checkout-related user corrections");
        expect(recommendation?.labels).toMatchObject({
            kind: "jit_checkout_guidance",
            trigger: "checkout_user_corrections",
        });
        expect(recommendation?.metrics).toMatchObject({
            correctionCount: 3,
            threshold: 3,
        });
    });

    test("checkout guidance stays below threshold with fewer than three corrections", () => {
        const recommendation = deriveRecommendationFromFriction([
            {
                key: "correction-1",
                kind: "user_correction",
                text: "Actually check the checkout first.",
                labels: { repository: "repository:ax", scope: "repository" },
                ts: "2026-05-09T10:00:00.000Z",
            },
            {
                key: "correction-2",
                kind: "user_correction",
                text: "Wrong branch for this worktree.",
                labels: { repository: "repository:ax", scope: "repository" },
                ts: "2026-05-09T10:05:00.000Z",
            },
        ]);

        expect(recommendation).toBeNull();
    });

    test("skips all-time skill pair aggregate updates for since-scoped derives", () => {
        expect(shouldDeriveAllTimeSkillPairs(undefined)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(0)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(1)).toBe(false);
    });
});
