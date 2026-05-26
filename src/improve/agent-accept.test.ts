import { describe, expect, test } from "bun:test";
import { buildAgentAcceptPrompt, runAgentAccept } from "./agent-accept.ts";

describe("buildAgentAcceptPrompt", () => {
    const ctx = {
        skillPath: "/home/u/.claude/skills/pre-bash-guard/SKILL.md",
        proposalTitle: "Pre-Bash guard",
        hypothesis: "Bash failed 7 times across 3 sessions.",
        triggerPattern: "tool=Bash",
        proposedBehavior: "validate Bash preconditions before invocation",
        retroSummaries: [
            "session abc: top tool Bash failed ×5",
            "session def: top tool Bash failed ×2",
        ],
        relatedSkillsDir: "/home/u/.claude/skills/",
    };

    test("includes skillPath, triggerPattern, and every retro summary", () => {
        const out = buildAgentAcceptPrompt(ctx);
        expect(out).toContain(ctx.skillPath);
        expect(out).toContain("tool=Bash");
        for (const r of ctx.retroSummaries) {
            expect(out).toContain(r);
        }
    });

    test("mentions proposed behavior and hypothesis", () => {
        const out = buildAgentAcceptPrompt(ctx);
        expect(out).toContain("validate Bash preconditions before invocation");
        expect(out).toContain("Bash failed 7 times across 3 sessions.");
    });

    test("renders fallback line when no retros", () => {
        const out = buildAgentAcceptPrompt({ ...ctx, retroSummaries: [] });
        expect(out).toContain("(no recent retros captured)");
    });

    test("includes the related skills directory + sibling PLAN.md path", () => {
        const out = buildAgentAcceptPrompt(ctx);
        expect(out).toContain(ctx.relatedSkillsDir);
        expect(out).toContain("PLAN.md");
    });
});

describe("runAgentAccept smoke", () => {
    test("skipped unless AX_AGENT_SMOKE=1", async () => {
        if (process.env.AX_AGENT_SMOKE !== "1") {
            expect(true).toBe(true);
            return;
        }
        // Smoke path - opt-in, expensive. Requires `claude` on PATH.
        const result = await runAgentAccept({
            skillPath: "/tmp/ax-agent-smoke/SKILL.md",
            proposalTitle: "smoke",
            hypothesis: "h",
            triggerPattern: "t",
            proposedBehavior: "b",
            retroSummaries: ["session x: Bash failed ×1"],
            relatedSkillsDir: "/tmp",
        });
        expect(result.exitCode).toBeGreaterThanOrEqual(0);
    });
});
