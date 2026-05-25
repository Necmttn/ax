import { describe, expect, test } from "bun:test";
import {
    deriveDiagnosticsFromToolCalls,
    deriveFrictionFromToolCalls,
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

    test("skips all-time skill pair aggregate updates for since-scoped derives", () => {
        expect(shouldDeriveAllTimeSkillPairs(undefined)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(0)).toBe(true);
        expect(shouldDeriveAllTimeSkillPairs(1)).toBe(false);
    });
});
