import { describe, expect, test } from "bun:test";
import {
    buildOpportunityStatements,
    hookBasenameFromArtifactPath,
    kebabNameFromArtifactPath,
    opportunityKey,
    overlapFilesMatch,
    parseOverlapFiles,
    parseSkillTriggerTool,
    resolveGuidanceTargetPath,
    triggerTokensFromCandidate,
} from "./derive-opportunities.ts";

describe("opportunityKey", () => {
    test("deterministic for the same (experiment, evidence) pair", () => {
        const a = opportunityKey("exp_a", "fix_b");
        const b = opportunityKey("exp_a", "fix_b");
        expect(a).toBe(b);
        expect(a).not.toBe(opportunityKey("exp_a", "fix_c"));
    });
});

describe("parseOverlapFiles", () => {
    test("handles JSON array", () => {
        expect(parseOverlapFiles('["schema/schema.surql","src/x.ts"]')).toEqual([
            "schema/schema.surql",
            "src/x.ts",
        ]);
    });

    test("handles null + invalid + non-array", () => {
        expect(parseOverlapFiles(null)).toEqual([]);
        expect(parseOverlapFiles("not-json")).toEqual([]);
        expect(parseOverlapFiles('{"a":1}')).toEqual([]);
    });
});

describe("triggerTokensFromCandidate", () => {
    test("drops short + boilerplate tokens", () => {
        expect(triggerTokensFromCandidate("SurrealDB_schema_change_guardrail")).toEqual([
            "surrealdb",
            "schema",
            "change",
        ]);
        expect(triggerTokensFromCandidate("graph_query_dogfood_checklist")).toEqual([
            "graph",
            "query",
            "dogfood",
        ]);
    });
});

describe("overlapFilesMatch", () => {
    test("matches when any token is a substring of any file path", () => {
        expect(
            overlapFilesMatch(["schema/schema.surql"], ["schema", "change"]),
        ).toBe(true);
        expect(
            overlapFilesMatch(["src/dashboard/web/styles.css"], ["schema"]),
        ).toBe(false);
        expect(overlapFilesMatch([], ["anything"])).toBe(false);
        expect(overlapFilesMatch(["a.ts"], [])).toBe(false);
    });
});

describe("buildOpportunityStatements", () => {
    test("emits DELETE + RELATE per match with stable edge id", () => {
        const stmts = buildOpportunityStatements("exp_1", [
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_a", ts: "2026-05-25T00:00:00.000Z" },
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_b", ts: "2026-05-25T01:00:00.000Z" },
        ]);
        const sql = stmts.join("\n");
        expect(sql.match(/DELETE opportunity:/g)?.length).toBe(2);
        expect(sql.match(/RELATE experiment:/g)?.length).toBe(2);
        expect(sql).toContain("was_addressed = false");
        expect(sql).toContain("->opportunity:");
        expect(sql).toContain("->later_fixed_by:");
    });

    test("no matches -> no statements", () => {
        expect(buildOpportunityStatements("exp_1", [])).toEqual([]);
    });

    test("addressed=true serializes was_addressed = true", () => {
        const stmts = buildOpportunityStatements("exp_1", [
            { evidenceTable: "later_fixed_by", evidenceKey: "edge_a", ts: "2026-05-25T00:00:00.000Z", addressed: true },
        ]);
        const sql = stmts.join("\n");
        expect(sql).toContain("was_addressed = true");
        expect(sql).not.toContain("was_addressed = false");
    });
});

describe("kebabNameFromArtifactPath (C5a addressed-detector helper)", () => {
    test("extracts the parent-dir kebab name", () => {
        expect(kebabNameFromArtifactPath("/Users/n/.claude/skills/schema-change-guardrail/SKILL.md"))
            .toBe("schema-change-guardrail");
        expect(kebabNameFromArtifactPath("./skills/x/SKILL.md")).toBe("x");
    });

    test("returns null for null/empty/single-segment", () => {
        expect(kebabNameFromArtifactPath(null)).toBeNull();
        expect(kebabNameFromArtifactPath("")).toBeNull();
        expect(kebabNameFromArtifactPath("/SKILL.md")).toBeNull();
    });
});

describe("hookBasenameFromArtifactPath (hook-form addressed-detector helper)", () => {
    test("returns the .sh basename", () => {
        expect(hookBasenameFromArtifactPath("/Users/x/.claude/hooks/pre-bash-guard.sh"))
            .toBe("pre-bash-guard.sh");
        expect(hookBasenameFromArtifactPath("./hooks/my-hook.sh")).toBe("my-hook.sh");
    });

    test("returns null for null/empty/non-.sh paths", () => {
        expect(hookBasenameFromArtifactPath(null)).toBeNull();
        expect(hookBasenameFromArtifactPath("")).toBeNull();
        expect(hookBasenameFromArtifactPath("/Users/x/.claude/hooks/script.py")).toBeNull();
        expect(hookBasenameFromArtifactPath("/Users/x/.claude/hooks/")).toBeNull();
    });
});

describe("parseSkillTriggerTool", () => {
    test("extracts the tool name from a tool=<Name> pattern", () => {
        expect(parseSkillTriggerTool("tool=Bash")).toBe("Bash");
        expect(parseSkillTriggerTool("tool=Read")).toBe("Read");
        expect(parseSkillTriggerTool("  tool=Edit  ")).toBe("Edit");
    });

    test("returns null for unrecognised patterns", () => {
        expect(parseSkillTriggerTool("garbage")).toBeNull();
        expect(parseSkillTriggerTool("")).toBeNull();
        expect(parseSkillTriggerTool("cmd=foo")).toBeNull();
    });
});

describe("resolveGuidanceTargetPath", () => {
    const home = "/Users/test";

    test("expands bare CLAUDE.md / AGENTS.md to <home>/.claude/<file>", () => {
        expect(resolveGuidanceTargetPath("CLAUDE.md", home)).toBe("/Users/test/.claude/CLAUDE.md");
        expect(resolveGuidanceTargetPath("AGENTS.md", home)).toBe("/Users/test/.claude/AGENTS.md");
    });

    test("expands ~/ prefix to home", () => {
        expect(resolveGuidanceTargetPath("~/.claude/CLAUDE.md", home)).toBe("/Users/test/.claude/CLAUDE.md");
    });

    test("leaves absolute paths unchanged", () => {
        expect(resolveGuidanceTargetPath("/etc/foo", home)).toBe("/etc/foo");
    });

    test("leaves other relative paths unchanged", () => {
        expect(resolveGuidanceTargetPath("docs/notes.md", home)).toBe("docs/notes.md");
    });
});
