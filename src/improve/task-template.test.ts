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
});
