import { describe, expect, test } from "bun:test";
import { hasActiveClaudeRouteDispatch } from "./installed-guards.ts";
import type { ConfiguredHook } from "./providers/types.ts";

const hook = (overrides: Partial<ConfiguredHook> = {}): ConfiguredHook => ({
    id: "hook-1",
    provider: "claude",
    scope: "global",
    file: "/home/me/.claude/settings.json",
    event: "PreToolUse",
    matcher: "Agent",
    command: "bun /home/me/.ax/hooks/route-dispatch.js # ax:abc123",
    enabled: true,
    owner: "ax",
    ...overrides,
});

describe("hasActiveClaudeRouteDispatch", () => {
    test.each([
        "bun /home/me/.ax/hooks/route-dispatch.js # ax:a",
        "bun /home/me/.ax/hooks/dispatch.ts # ax:b",
        "bun /home/me/.ax/hooks/dispatch-shim.js # ax:c",
    ])("recognizes direct, dispatcher, and dispatcher-shim registrations", (command) => {
        expect(hasActiveClaudeRouteDispatch([hook({ command })])).toBe(true);
    });

    test("recognizes Agent as one exact tool in a dispatcher matcher", () => {
        expect(hasActiveClaudeRouteDispatch([hook({ matcher: "Edit|Agent|Write", command: "bun /x/dispatch.js" })])).toBe(true);
        expect(hasActiveClaudeRouteDispatch([hook({ matcher: "Subagent", command: "bun /x/dispatch.js" })])).toBe(false);
    });

    test("does not use parked, non-Claude, wrong-event, or unrelated registrations", () => {
        expect(hasActiveClaudeRouteDispatch([hook({ enabled: false })])).toBe(false);
        expect(hasActiveClaudeRouteDispatch([hook({ provider: "codex" })])).toBe(false);
        expect(hasActiveClaudeRouteDispatch([hook({ event: "PostToolUse" })])).toBe(false);
        expect(hasActiveClaudeRouteDispatch([hook({ command: "bun /x/enforce-worktree.js" })])).toBe(false);
    });
});
