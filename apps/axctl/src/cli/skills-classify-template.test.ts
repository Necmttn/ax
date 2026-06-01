import { describe, expect, test } from "bun:test";
import { renderClassifyBrief, skillNameToSlug } from "./skills-classify-template.ts";

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

    test("output is valid markdown (starts with heading)", () => {
        const out = renderClassifyBrief(base);
        expect(out.trimStart()).toMatch(/^# ax classify:/);
    });
});
