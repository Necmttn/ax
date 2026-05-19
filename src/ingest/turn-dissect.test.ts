import { describe, expect, test } from "bun:test";
import { dissectTurn } from "./turn-dissect.ts";

describe("dissectTurn", () => {
    test("plain text is one user_input span", () => {
        const spans = dissectTurn("hey can you look at this?");
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({ kind: "user_input", text: "hey can you look at this?" });
    });

    test("empty input returns no spans", () => {
        expect(dissectTurn("")).toEqual([]);
    });

    test("isolates a command-name wrapper", () => {
        const spans = dissectTurn("<command-name>/goal</command-name>");
        expect(spans).toHaveLength(1);
        expect(spans[0]!.kind).toBe("wrapper_instruction");
    });

    test("text before and after a system-reminder produces three spans", () => {
        const text = "hey\n<system-reminder>be careful</system-reminder>\nthanks";
        const spans = dissectTurn(text);
        expect(spans.map((s) => s.kind)).toEqual(["user_input", "system_context", "user_input"]);
        expect(spans[1]!.text).toContain("<system-reminder>");
    });

    test("recognises an ax_file_memory hook injection", () => {
        const text = "<ax_file_memory>\nFile: src/x.ts\nstuff\n</ax_file_memory>\nfix the thing";
        const spans = dissectTurn(text);
        expect(spans.map((s) => s.kind)).toEqual(["hook_injection", "user_input"]);
        expect(spans[0]!.label).toBe("ax_file_memory");
    });

    test("'Base directory for this skill:' marker absorbs the rest of the text", () => {
        const text =
            "Base directory for this skill: /a/b/c/skills/tdd\n\n# Test-Driven Development\n\nrules: write tests first";
        const spans = dissectTurn(text);
        expect(spans).toHaveLength(1);
        expect(spans[0]!.kind).toBe("skill_context");
        // Label is the skill identifier only; renderer composes the "skill: " prefix.
        expect(spans[0]!.label).toBe("tdd");
    });

    test("tool_use placeholder is detected as tool_use kind", () => {
        const text = "<tool_use>{\"file_path\":\"x.ts\"}</tool_use>some prose";
        const spans = dissectTurn(text, { defaultKind: "assistant_text" });
        expect(spans.map((s) => s.kind)).toEqual(["tool_use", "assistant_text"]);
        expect(spans[0]!.label).toBe("tool_use");
    });

    test("tool_use with name attribute exposes the tool name as label", () => {
        const text = "<tool_use name=\"Read\">{\"file_path\":\"x.ts\"}</tool_use>";
        const spans = dissectTurn(text, { defaultKind: "assistant_text" });
        expect(spans[0]!.kind).toBe("tool_use");
        expect(spans[0]!.label).toBe("Read");
    });

    test("defaultKind override applies to unmatched text", () => {
        const spans = dissectTurn("a long assistant response with no tags", { defaultKind: "assistant_text" });
        expect(spans).toHaveLength(1);
        expect(spans[0]!.kind).toBe("assistant_text");
    });

    test("user_input followed by a skill autoload splits correctly", () => {
        const text = "hello\n\nBase directory for this skill: /skills/foo\n\n# Foo\n\nbody";
        const spans = dissectTurn(text);
        expect(spans.map((s) => s.kind)).toEqual(["user_input", "skill_context"]);
        expect(spans[0]!.text.trim()).toBe("hello");
    });

    test("mixed payload: command tags + system-reminder + ax_file_memory + user text", () => {
        const text = [
            "<command-name>/goal</command-name>",
            "<command-args>fix bug</command-args>",
            "<local-command-stdout>goal set</local-command-stdout>",
            "<system-reminder>session-scoped Stop hook active</system-reminder>",
            "<ax_file_memory>File: x\n</ax_file_memory>",
            "ok let's do it",
        ].join("\n");
        const spans = dissectTurn(text);
        const kinds = spans.map((s) => s.kind);
        expect(kinds).toEqual([
            "wrapper_instruction",
            "wrapper_instruction",
            "tool_result",
            "system_context",
            "hook_injection",
            "user_input",
        ]);
    });

    test("CLAUDE.md autoload prefix is captured as system_context", () => {
        const text = "Contents of /Users/x/Projects/ax/CLAUDE.md (project)\n\n# project rules";
        const spans = dissectTurn(text);
        expect(spans[0]!.kind).toBe("system_context");
        expect(spans[0]!.label).toBe("CLAUDE.md autoload");
    });

    test("AGENTS.md autoload prefix is captured as system_context", () => {
        const text = "# AGENTS.md instructions for /Users/x/Projects/quera\n\n# CLAUDE.md\n\nrules";
        const spans = dissectTurn(text);
        expect(spans[0]!.kind).toBe("system_context");
        expect(spans[0]!.label).toBe("AGENTS.md");
    });

    test("Codex developer-preamble blocks are tagged as system_context", () => {
        const text = [
            "<permissions instructions>sandbox=danger-full-access</permissions instructions>",
            "<apps_instructions>## Apps...</apps_instructions>",
            "<skills_instructions>## Skills...</skills_instructions>",
            "<plugins_instructions>## Plugins...</plugins_instructions>",
        ].join("");
        const spans = dissectTurn(text);
        expect(spans.map((s) => s.kind)).toEqual([
            "system_context",
            "system_context",
            "system_context",
            "system_context",
        ]);
        expect(spans.map((s) => s.label)).toEqual([
            "permissions",
            "apps_instructions",
            "skills_instructions",
            "plugins_instructions",
        ]);
    });
});
