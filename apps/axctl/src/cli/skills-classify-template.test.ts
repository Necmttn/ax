import { describe, expect, test } from "bun:test";
import { renderClassifyBrief, skillNameToSlug } from "./skills-classify-template.ts";
import { parseBrief } from "./skills-lint.ts";

describe("skillNameToSlug", () => {
    test("replaces colons with double underscore", () => {
        expect(skillNameToSlug("superpowers:subagent-driven-development")).toBe(
            "superpowers__subagent-driven-development",
        );
    });

    test("replaces non-alphanumeric-hyphen-underscore with hyphen", () => {
        expect(skillNameToSlug("foo bar")).toBe("foo-bar");
        expect(skillNameToSlug("foo.bar")).toBe("foo-bar");
    });

    test("handles plugin-namespaced name with colon and hyphen", () => {
        expect(skillNameToSlug("codex:rescue")).toBe("codex__rescue");
    });

    test("plain skill name passes through unchanged", () => {
        expect(skillNameToSlug("pre-bash-guard")).toBe("pre-bash-guard");
    });

    test("multiple colons are all replaced", () => {
        expect(skillNameToSlug("a:b:c")).toBe("a__b__c");
    });
});

describe("renderClassifyBrief", () => {
    const base = {
        skillName: "superpowers:subagent-driven-development",
        invocations: 42,
        sessions: 7,
    };

    test("includes skill name in title", () => {
        const out = renderClassifyBrief(base);
        expect(out).toContain("# ax classify: superpowers:subagent-driven-development");
    });

    test("includes invocation and session counts in Why section", () => {
        const out = renderClassifyBrief(base);
        expect(out).toContain("42 invocations");
        expect(out).toContain("7 sessions");
    });

    test("frontmatter provenance line uses exact skill name", () => {
        const out = renderClassifyBrief(base);
        expect(out).toContain(
            "`ax_classify: superpowers:subagent-driven-development`",
        );
    });

    test("YAML block uses exact skill name in ax_classify field", () => {
        const out = renderClassifyBrief(base);
        expect(out).toContain("ax_classify: superpowers:subagent-driven-development");
    });

    test("includes axctl skills tag one-liner override hint", () => {
        const out = renderClassifyBrief(base);
        expect(out).toContain(
            `axctl skills tag superpowers:subagent-driven-development <role>`,
        );
    });

    test("includes axctl skills lint instruction", () => {
        const out = renderClassifyBrief(base);
        expect(out).toContain("axctl skills lint");
    });

    test("stats and recent commands reference skill name", () => {
        const out = renderClassifyBrief(base);
        expect(out).toContain(
            "axctl skills stats superpowers:subagent-driven-development",
        );
        expect(out).toContain(
            "axctl skills recent superpowers:subagent-driven-development",
        );
    });

    test("plain skill name (no colon) renders correctly", () => {
        const out = renderClassifyBrief({
            skillName: "pre-bash-guard",
            invocations: 10,
            sessions: 3,
        });
        expect(out).toContain("# ax classify: pre-bash-guard");
        expect(out).toContain("10 invocations");
        expect(out).toContain("3 sessions");
        expect(out).toContain("ax_classify: pre-bash-guard");
    });

    test("output starts with top-of-file YAML frontmatter", () => {
        const out = renderClassifyBrief(base);
        expect(out.startsWith("---\n")).toBe(true);
        expect(out).toMatch(/^---\nax_classify: /);
        // The frontmatter block is closed before the markdown body starts
        expect(out).toContain("---\n\n# ax classify:");
    });

    test("does not scaffold the YAML inside a fenced code block", () => {
        const out = renderClassifyBrief(base);
        expect(out).not.toContain("```yaml");
    });
});

describe("renderClassifyBrief -> skills lint round-trip", () => {
    const base = {
        skillName: "superpowers:subagent-driven-development",
        invocations: 42,
        sessions: 7,
    };

    test("freshly emitted brief parses as pending (no primary_role yet)", () => {
        const out = renderClassifyBrief(base);
        // null = pending, not an error - lint leaves the file alone
        expect(parseBrief(out, "classify-test.md")).toBeNull();
    });

    test("filling primary_role makes the brief lint-applicable as scaffolded", () => {
        const out = renderClassifyBrief(base);
        const filled = out.replace(
            "primary_role:           # required, single string",
            "primary_role: execution # required, single string",
        );
        expect(filled).not.toBe(out);

        const parsed = parseBrief(filled, "classify-test.md");
        expect(parsed).not.toBeNull();
        if (parsed === null || "error" in parsed) {
            throw new Error(`expected filled brief to parse, got: ${JSON.stringify(parsed)}`);
        }
        expect(parsed.ax_classify).toBe("superpowers:subagent-driven-development");
        expect(parsed.primary_role).toBe("execution");
        expect(parsed.secondary).toEqual([]);
        expect(parsed.confidence).toBe(1.0);
    });

    test("filled brief round-trips with secondary roles and rationale", () => {
        const out = renderClassifyBrief({
            skillName: "pre-bash-guard",
            invocations: 10,
            sessions: 3,
        });
        const filled = out
            .replace(
                "primary_role:           # required, single string",
                "primary_role: verification",
            )
            .replace(
                "secondary: []           # optional, list of strings",
                "secondary: [framing, repair]",
            )
            .replace(
                "  Explain why you picked these roles.",
                "  Guards bash preconditions before execution.",
            );

        const parsed = parseBrief(filled, "classify-pre-bash-guard.md");
        if (parsed === null || "error" in parsed) {
            throw new Error(`expected filled brief to parse, got: ${JSON.stringify(parsed)}`);
        }
        expect(parsed.ax_classify).toBe("pre-bash-guard");
        expect(parsed.primary_role).toBe("verification");
        expect(parsed.secondary).toEqual(["framing", "repair"]);
        expect(parsed.rationale).toBe("Guards bash preconditions before execution.");
    });
});
