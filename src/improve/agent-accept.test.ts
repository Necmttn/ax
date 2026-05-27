import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentAcceptPrompt, runAgentAccept } from "./agent-accept.ts";
import { acceptProposal } from "./actions.ts";
import { SurrealClient } from "../lib/db.ts";

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

// ---------------------------------------------------------------------------
// fakeRowsLayer: feed successive query() calls from a fixture array
// ---------------------------------------------------------------------------
const fakeRowsLayer = (fixtures: ReadonlyArray<unknown[]>) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(_: string) => Effect.sync(() => (fixtures[i++] ?? []) as unknown as T),
    } as never);
};

describe("acceptProposal - task emission", () => {
    test("guidance form emits .ax/tasks/<id>.md (no direct file scaffold)", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: "proposal:guid1",
            form: "guidance",
            title: "Add pre-bash guidance",
            hypothesis: "Bash failed repeatedly without pre-checks",
            dedupe_sig: "e7f3abcd",
            status: "open",
            skill_payload: null,
            guidance_payload: {
                file_target: "~/.claude/CLAUDE.md",
                section: "Pre-Bash",
                suggested_text: "Always validate bash preconditions.",
            },
        };

        const layer = fakeRowsLayer([
            [[proposalRow]],   // fetchFullProposal: query returns [FullProposalRow[]]
            [[]],              // UPDATE + UPSERT (ignored by fake)
        ]);

        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: "e7f3abcd", taskDir }).pipe(
                Effect.provide(layer),
            ),
        );

        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        expect(result.artifact_path).toBeUndefined();
        expect(existsSync(result.task_path!)).toBe(true);

        const body = readFileSync(result.task_path!, "utf-8");
        expect(body).toContain("form=guidance");
        expect(body).toContain("<!--ax:e7f3abcd-->");
    });

    test("skill form defaults to task emission (no autoScaffold)", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: "proposal:skill1",
            form: "skill",
            title: "Pre-Bash guard skill",
            hypothesis: "Bash failed 7 times",
            dedupe_sig: "skill1ab",
            status: "open",
            skill_payload: {
                proposed_behavior: "validate preconditions before Bash",
                trigger_pattern: "tool=Bash",
                expected_impact: "reduces failures",
            },
            guidance_payload: null,
        };

        const layer = fakeRowsLayer([
            [[proposalRow]],
            [[]],
        ]);

        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: "skill1ab", taskDir }).pipe(
                Effect.provide(layer),
            ),
        );

        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        expect(result.artifact_path).toBeUndefined();
        expect(existsSync(result.task_path!)).toBe(true);

        const body = readFileSync(result.task_path!, "utf-8");
        expect(body).toContain("form=skill");
        expect(body).toContain("ax_id: skill1ab");
    });

    test("skill form with autoScaffold=true preserves direct-write path", async () => {
        const scaffoldBaseDir = mkdtempSync(join(tmpdir(), "ax-scaffold-"));
        const proposalRow = {
            id: "proposal:skill2",
            form: "skill",
            title: "My Direct Skill",
            hypothesis: "direct scaffold test",
            dedupe_sig: "skill2cd",
            status: "open",
            skill_payload: {
                proposed_behavior: "do the thing directly",
                trigger_pattern: null,
                expected_impact: null,
            },
            guidance_payload: null,
        };

        const layer = fakeRowsLayer([
            [[proposalRow]],
            [[]],
        ]);

        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: "skill2cd", autoScaffold: true, scaffoldBaseDir }).pipe(
                Effect.provide(layer),
            ),
        );

        expect(result.status).toBe("ok");
        expect(result.artifact_path).toBeDefined();
        expect(result.task_path).toBeUndefined();
        expect(existsSync(result.artifact_path!)).toBe(true);
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
