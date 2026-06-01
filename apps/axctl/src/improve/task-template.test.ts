import { describe, expect, test } from "bun:test";
import { renderTaskFile, type TaskInput } from "./task-template.ts";

const baseInput = (overrides: Partial<TaskInput> = {}): TaskInput => ({
    form: "hook",
    experimentId: "experiment:hook",
    proposalId: "proposal:hook",
    shortId: "hook_sig",
    title: "Pre-Bash guard",
    targetPath: "~/.claude/settings.json",
    section: "PreToolUse",
    suggestedBody: "bash ~/.claude/hooks/pre-bash-guard.sh",
    proposedBehavior: null,
    confidence: "medium",
    frequency: 2,
    evidence: "Bash failed repeatedly",
    safety: {
        recoveryPath: "Remove the hook entry from settings.json",
        smokeTestCommand: "bun test src/improve/lifecycle.test.ts",
        disableCommand: "mv hook.sh hook.sh.disabled",
        failureMode: "fail_open",
    },
    ...overrides,
});

describe("renderTaskFile", () => {
    test("renders subagent task brief with frontmatter provenance", () => {
        const body = renderTaskFile(baseInput({
            form: "subagent",
            experimentId: "experiment:subagent",
            proposalId: "proposal:subagent",
            shortId: "subagent_sig",
            targetPath: "~/.claude/agents/subagent_sig.md",
            suggestedBody: "Handle bounded review tasks.",
        }));
        expect(body).toContain("form=subagent");
        expect(body).toContain("ax_id: subagent_sig");
        expect(body).toContain("ax_experiment: experiment:subagent");
    });

    test("renders hook task brief with echo marker and safety contract", () => {
        const body = renderTaskFile(baseInput());
        expect(body).toContain("form=hook");
        expect(body).toContain("echo 'ax:hook_sig'");
        expect(body).toContain("Recovery Path: Remove the hook entry from settings.json");
        expect(body).toContain("Failure Mode: fail_open");
    });

    test("renders automation task brief with plist and cron markers", () => {
        const body = renderTaskFile(baseInput({
            form: "automation",
            experimentId: "experiment:auto",
            proposalId: "proposal:auto",
            shortId: "automation_sig",
            targetPath: ".ax/interventions/automation_sig/AUTOMATION.md",
            suggestedBody: "Run weekly cleanup.",
        }));
        expect(body).toContain("form=automation");
        expect(body).toContain("<!-- ax:automation_sig experiment:experiment:auto -->");
        expect(body).toContain("# ax:automation_sig experiment:experiment:auto");
        expect(body).toContain("Run weekly cleanup.");
    });

    test("guidance: references experiment + proposal ids", () => {
        const out = renderTaskFile(baseInput({
            form: "guidance",
            experimentId: "experiment:guid_e7f3__lk9",
            proposalId: "proposal:guid_e7f3",
        }));
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
        expect(out).toContain("ax_id: hook_sig");
        expect(out).toContain("Validate Bash preconditions");
    });

    test("harness_check: instructs adding an executable check", () => {
        const out = renderTaskFile({
            ...baseInput(),
            form: "harness_check",
            experimentId: "experiment:guid_e7f3__lk9",
            shortId: "e7f3",
            targetPath: "tests/harness/surrealml-output-required.test.ts",
            section: null,
            suggestedBody: "Assert the SurrealML classifier command prints applied result evidence.",
            proposedBehavior: "Create a regression check that fails when classifier setup stops at HTML output.",
        });
        expect(out).toContain("form=harness_check");
        expect(out).toContain("**Action:** add harness check");
        expect(out).toContain("tests/harness/surrealml-output-required.test.ts");
        expect(out).toContain("Create a regression check");
        expect(out).toContain("ax_id: e7f3");
        expect(out).toContain("ax_experiment: experiment:guid_e7f3__lk9");
        expect(out).toContain("axctl improve lint");
    });

    test("includes a Lint section referencing `axctl improve lint`", () => {
        const out = renderTaskFile(baseInput());
        expect(out).toContain("axctl improve lint");
    });

    test("guidance: suggested block fence uses ```text not ```md (prevents false-positive marker copy-in)", () => {
        const out = renderTaskFile(baseInput({ form: "guidance" }));
        expect(out).not.toContain("```md\n<!--ax:");
        expect(out).toContain("```text\n<!--ax:");
    });
});
