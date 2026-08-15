import { describe, expect, test } from "bun:test";
import { buildAgentAcceptPrompt } from "./agent-accept.ts";
import { shouldScaffoldWorkflowSkill } from "./actions.ts";

describe("buildAgentAcceptPrompt", () => {
    test("includes the proposal and evidence", () => {
        const text = buildAgentAcceptPrompt({
            skillPath: "/tmp/SKILL.md",
            proposalTitle: "Pre-Bash guard",
            hypothesis: "Bash failed repeatedly.",
            triggerPattern: "tool=Bash",
            proposedBehavior: "validate preconditions",
            retroSummaries: ["session abc: Bash failed"],
            relatedSkillsDir: "/tmp/skills",
        });
        expect(text).toContain("Pre-Bash guard");
        expect(text).toContain("tool=Bash");
        expect(text).toContain("session abc");
    });
});

describe("shouldScaffoldWorkflowSkill", () => {
    test("accepts only workflow guidance", () => {
        expect(shouldScaffoldWorkflowSkill({ form: "guidance", guidance_payload: { section: "workflows" } })).toBe(true);
        expect(shouldScaffoldWorkflowSkill({ form: "guidance", guidance_payload: { section: "directives" } })).toBe(false);
        expect(shouldScaffoldWorkflowSkill({ form: "skill" })).toBe(false);
    });
});
