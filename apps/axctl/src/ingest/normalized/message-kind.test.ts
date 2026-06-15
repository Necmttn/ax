import { describe, expect, test } from "bun:test";
import {
    classifyUserText,
    FULL_CONTEXT_RULES,
    PI_CONTEXT_RULES,
    type UserTextRules,
} from "./message-kind.ts";

describe("classifyUserText", () => {
    // The user-branch excerpt → control|context|task rules, shared across parsers.
    // FULL_CONTEXT_RULES is claude≡codex (proven byte-identical pre-refactor);
    // PI_CONTEXT_RULES is the narrower pi subset.
    const cases: ReadonlyArray<{
        excerpt: string | null;
        full: "control" | "context" | "task";
        pi: "control" | "context" | "task";
        note: string;
    }> = [
        { excerpt: "<command-name>foo", full: "control", pi: "control", note: "control prefix shared" },
        { excerpt: "# CLAUDE.md here", full: "context", pi: "context", note: "CLAUDE.md shared" },
        {
            excerpt: "# AGENTS.md instructions for /x",
            full: "context",
            pi: "context",
            note: "AGENTS.md shared",
        },
        {
            excerpt: "wraps <environment_context> inside",
            full: "context",
            pi: "context",
            note: "environment_context include shared",
        },
        { excerpt: "<INSTRUCTIONS>do x", full: "context", pi: "context", note: "INSTRUCTIONS include shared" },
        // The three prefixes pi DELIBERATELY omits (narrower table preserved):
        {
            excerpt: "<local-command-caveat>note",
            full: "context",
            pi: "task",
            note: "local-command-caveat: full only",
        },
        {
            excerpt: "Base directory for this skill: /s",
            full: "context",
            pi: "task",
            note: "skill base dir: full only",
        },
        {
            excerpt: "Base directory for this plugin: /p",
            full: "context",
            pi: "task",
            note: "plugin base dir: full only",
        },
        { excerpt: "ordinary user request", full: "task", pi: "task", note: "plain task" },
        { excerpt: null, full: "task", pi: "task", note: "null excerpt → task" },
        { excerpt: "", full: "task", pi: "task", note: "empty excerpt → task" },
    ];

    for (const c of cases) {
        test(`${c.note}: ${JSON.stringify(c.excerpt)}`, () => {
            expect(classifyUserText(c.excerpt, FULL_CONTEXT_RULES)).toBe(c.full);
            expect(classifyUserText(c.excerpt, PI_CONTEXT_RULES)).toBe(c.pi);
        });
    }

    test("FULL_CONTEXT_RULES are the exact claude/codex context table", () => {
        expect(FULL_CONTEXT_RULES.control).toEqual(["<command-name>"]);
        expect(FULL_CONTEXT_RULES.contextStartsWith).toEqual([
            "# AGENTS.md instructions",
            "# CLAUDE.md",
            "<local-command-caveat>",
            "Base directory for this skill:",
            "Base directory for this plugin:",
        ]);
        expect(FULL_CONTEXT_RULES.contextIncludes).toEqual(["<environment_context>", "<INSTRUCTIONS>"]);
    });

    test("PI_CONTEXT_RULES are a strict subset of the full startsWith table", () => {
        expect(PI_CONTEXT_RULES.control).toEqual(["<command-name>"]);
        expect(PI_CONTEXT_RULES.contextStartsWith).toEqual(["# AGENTS.md instructions", "# CLAUDE.md"]);
        expect(PI_CONTEXT_RULES.contextIncludes).toEqual(["<environment_context>", "<INSTRUCTIONS>"]);
        // every pi startsWith rule is also in the full table (subset, not divergence)
        for (const prefix of PI_CONTEXT_RULES.contextStartsWith) {
            expect(FULL_CONTEXT_RULES.contextStartsWith).toContain(prefix);
        }
    });

    test("control takes precedence over context", () => {
        const rules: UserTextRules = {
            control: ["<command-name>"],
            contextStartsWith: ["<command-name>"],
            contextIncludes: [],
        };
        expect(classifyUserText("<command-name>x", rules)).toBe("control");
    });
});
