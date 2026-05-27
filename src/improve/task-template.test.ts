import { describe, expect, test } from "bun:test";
import { renderTaskFile, type TaskInput } from "./task-template.ts";

const baseInput = (): TaskInput => ({
    form: "guidance",
    experimentId: "experiment:guid_e7f3__lk9",
    proposalId: "proposal:guid_e7f3",
    shortId: "e7f3",
    title: "Use ripgrep instead of grep",
    targetPath: "~/.claude/CLAUDE.md",
    section: "Terminal Optimization",
    suggestedBody: "Use ripgrep instead of grep. Faster and respects gitignore.",
    confidence: "high",
    frequency: 3,
    evidence: "12 corrections across 4 sessions",
    proposedBehavior: null,
});

describe("renderTaskFile", () => {
    test("guidance: includes marker pair around suggested body", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("<!--ax:e7f3-->");
        expect(out).toContain("<!--/ax:e7f3-->");
        expect(out).toContain("Use ripgrep instead of grep");
    });

    test("guidance: includes target path and section", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("~/.claude/CLAUDE.md");
        expect(out).toContain("Terminal Optimization");
    });

    test("guidance: references experiment + proposal ids", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("experiment:guid_e7f3__lk9");
        expect(out).toContain("proposal:guid_e7f3");
    });

    test("skill: instructs creating ~/.claude/skills/<slug>/SKILL.md", () => {
        const out = renderTaskFile({
            ...baseInput(),
            form: "skill",
            proposedBehavior: "Validate Bash preconditions before invocation.",
            targetPath: "~/.claude/skills/pre-bash-guard/SKILL.md",
            section: null,
            suggestedBody: "",
        });
        expect(out).toContain("Create");
        expect(out).toContain("~/.claude/skills/pre-bash-guard/SKILL.md");
        expect(out).toContain("ax_id: e7f3");
        expect(out).toContain("Validate Bash preconditions");
    });

    test("includes a Lint section referencing `axctl improve lint`", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("axctl improve lint");
    });
});
