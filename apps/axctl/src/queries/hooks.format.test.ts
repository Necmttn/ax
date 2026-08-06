import { describe, expect, test } from "bun:test";
import {
    formatHookInvocationRows,
    formatHookSummaryRows,
    HOOK_EMPTY_NOTE,
    type HookInvocationRow,
    type HookSummaryRow,
} from "./hooks.ts";

describe("hook table empty state (#743)", () => {
    test("summary says what silence means instead of printing a bare header", () => {
        const out = formatHookSummaryRows([]);
        expect(out).toBe(HOOK_EMPTY_NOTE);
        expect(out).not.toStartWith("count\t");
        expect(out).toContain("not proof");
        expect(out).toContain("--reparse=claude");
    });

    test("invocations uses the same note", () => {
        expect(formatHookInvocationRows([])).toBe(HOOK_EMPTY_NOTE);
    });

    test("rows still render as TSV with a header", () => {
        const summary = formatHookSummaryRows([
            {
                count: 3,
                provider_status: "blocking_error",
                effect: "blocked",
                last_seen: "2026-08-05T09:00:00.000Z",
                hook_name: "PreToolUse:Bash",
                command: "bun /h/enforce-worktree.ts",
            } satisfies HookSummaryRow,
        ]);
        expect(summary.split("\n")[0]).toStartWith("count\t");
        expect(summary).toContain("PreToolUse:Bash");

        const invocations = formatHookInvocationRows([
            {
                ts: "2026-08-05T09:00:00.000Z",
                session: "session:abc",
                event_name: "PreToolUse",
                provider_status: "blocking_error",
                effect: "blocked",
                hook_name: "PreToolUse:Bash",
                command: "bun /h/enforce-worktree.ts",
                blocking_error_excerpt: "BLOCKED: dirty tree",
            } satisfies HookInvocationRow,
        ]);
        expect(invocations.split("\n")[0]).toStartWith("ts\t");
        expect(invocations).toContain("BLOCKED: dirty tree");
    });
});
