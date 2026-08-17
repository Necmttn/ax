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
        // Harness injections. Each of these was MEASURED landing on a `task`
        // turn in a real store, and `task` is what every "what did the human
        // ask for" surface keys off. They are claude/codex shapes, so pi's
        // narrower table leaves them as `task` on purpose.
        {
            excerpt: "<task-notification>agent finished",
            full: "context",
            pi: "task",
            note: "task-notification (392 rows, the largest leak)",
        },
        {
            excerpt: "[SYSTEM NOTIFICATION] background task done",
            full: "context",
            pi: "task",
            note: "SYSTEM NOTIFICATION",
        },
        {
            excerpt: "<recommended_plugins>\nHere is a list of plugins",
            full: "context",
            pi: "task",
            note: "recommended_plugins - the shape that caught a hand-written filter out",
        },
        { excerpt: "<user_action>\n  <context>", full: "context", pi: "task", note: "user_action" },
        {
            excerpt: "Stop hook feedback:\n- blocked",
            full: "context",
            pi: "task",
            note: "Stop hook feedback",
        },
        {
            excerpt: '<skill name="fleet-ship" location="/x">',
            full: "context",
            pi: "task",
            note: "auto-loaded skill body is not a request",
        },
        {
            excerpt: "<local-command-stdout>ok",
            full: "context",
            pi: "task",
            note: "command OUTPUT is context; the invocation is control",
        },
        // An interrupt is a user CONTROL action, not injected context and not a
        // typed request - so it is neither `context` nor `task`.
        {
            excerpt: "[Request interrupted by user]",
            full: "control",
            pi: "task",
            note: "interrupt is control, not context",
        },
        // Attachment markers. This rule is SHARED with pi (see the note on
        // PI_CONTEXT_RULES): unlike a prefix, it cannot swallow a typed
        // sentence, so it needs no per-harness evidence.
        {
            excerpt: "[Image: source: /Users/x/shot.png]",
            full: "context",
            pi: "context",
            note: "a lone attachment marker is not a request",
        },
        {
            excerpt: "[Image: original 1290x2796, displayed at 923x2000. Multiply by 1.40.]",
            full: "context",
            pi: "context",
            note: "the resize note is machine text too",
        },
        {
            excerpt: "[Image: source: /a.png]\n[Image: source: /b.png]\n[Image: source: /c.png]",
            full: "context",
            pi: "context",
            note: "THREE stacked markers - 208 chars, which is why a length cutoff fails",
        },
        // The human form. `[Image #1]` has no colon, and the sentence after it
        // is the request. Dropping this would lose real prompts.
        {
            excerpt: "[Image #1] why is it gigantic?",
            full: "task",
            pi: "task",
            note: "an attachment REFERENCE inside a typed message stays a task",
        },
        {
            excerpt: "[Image: source: /a.png] make the header smaller",
            full: "task",
            pi: "task",
            note: "a marker plus typed words is still a request",
        },
    ];

    for (const c of cases) {
        test(`${c.note}: ${JSON.stringify(c.excerpt)}`, () => {
            expect(classifyUserText(c.excerpt, FULL_CONTEXT_RULES)).toBe(c.full);
            expect(classifyUserText(c.excerpt, PI_CONTEXT_RULES)).toBe(c.pi);
        });
    }

    // The original four claude/codex context prefixes are pinned INDIVIDUALLY
    // rather than as an exact array. An exact-array assertion made the table
    // append-hostile: every genuinely-correct new injection rule failed a test
    // that was only ever meant to catch an accidental DELETION. These say what
    // they mean - the founding rules must not disappear.
    test("FULL_CONTEXT_RULES keeps the founding claude/codex context prefixes", () => {
        for (const prefix of [
            "# AGENTS.md instructions",
            "# CLAUDE.md",
            "<local-command-caveat>",
            "Base directory for this skill:",
            "Base directory for this plugin:",
        ]) {
            expect(FULL_CONTEXT_RULES.contextStartsWith).toContain(prefix);
        }
        expect(FULL_CONTEXT_RULES.control).toContain("<command-name>");
        expect(FULL_CONTEXT_RULES.contextIncludes).toEqual(["<environment_context>", "<INSTRUCTIONS>"]);
    });

    test("PI_CONTEXT_RULES stays the narrower table, and shares only the marker rule", () => {
        expect(PI_CONTEXT_RULES.control).toEqual(["<command-name>"]);
        expect(PI_CONTEXT_RULES.contextStartsWith).toEqual(["# AGENTS.md instructions", "# CLAUDE.md"]);
        expect(PI_CONTEXT_RULES.contextIncludes).toEqual(["<environment_context>", "<INSTRUCTIONS>"]);
        // every pi startsWith rule is also in the full table (subset, not divergence)
        for (const prefix of PI_CONTEXT_RULES.contextStartsWith) {
            expect(FULL_CONTEXT_RULES.contextStartsWith).toContain(prefix);
        }
        // the attachment rule is the one thing deliberately NOT narrowed
        expect(PI_CONTEXT_RULES.attachmentMarkers).toEqual(FULL_CONTEXT_RULES.attachmentMarkers);
    });

    test("control takes precedence over context", () => {
        const rules: UserTextRules = {
            control: ["<command-name>"],
            contextStartsWith: ["<command-name>"],
            contextIncludes: [],
            attachmentMarkers: [],
        };
        expect(classifyUserText("<command-name>x", rules)).toBe("control");
    });

    // The "at least one match" half of the marker rule. Without it, stripping an
    // empty excerpt leaves an empty string, which reads as marker-only and would
    // move EVERY empty user turn from task to context.
    test("an empty excerpt is not mistaken for marker-only text", () => {
        const rules: UserTextRules = {
            control: [],
            contextStartsWith: [],
            contextIncludes: [],
            attachmentMarkers: [/\[Image: [^\]]*\]/],
        };
        expect(classifyUserText("", rules)).toBe("task");
        expect(classifyUserText("   ", rules)).toBe("task");
    });

    // A marker RegExp is a module-level constant shared by both rule tables, so
    // a stateful `lastIndex` would make the SECOND call on the same input
    // disagree with the first. Classification must not depend on call order.
    test("repeated calls agree - the marker regexes hold no state", () => {
        const excerpt = "[Image: source: /a.png]";
        expect(classifyUserText(excerpt, FULL_CONTEXT_RULES)).toBe("context");
        expect(classifyUserText(excerpt, FULL_CONTEXT_RULES)).toBe("context");
        expect(classifyUserText(excerpt, PI_CONTEXT_RULES)).toBe("context");
        expect(classifyUserText(excerpt, FULL_CONTEXT_RULES)).toBe("context");
    });
});
