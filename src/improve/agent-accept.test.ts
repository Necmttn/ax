import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentAcceptPrompt, runAgentAccept } from "./agent-accept.ts";
import { acceptProposal } from "./actions.ts";
import { SurrealClient } from "../lib/db.ts";
import { DbError } from "../lib/errors.ts";

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
        // dedupe_sig is LONGER than 8 chars to catch shortId truncation bugs
        const longSig = "guidance__abcdef12345";
        const proposalRow = {
            id: "proposal:guid1",
            form: "guidance",
            title: "Add pre-bash guidance",
            hypothesis: "Bash failed repeatedly without pre-checks",
            dedupe_sig: longSig,
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
            acceptProposal({ sigOrId: longSig, taskDir }).pipe(
                Effect.provide(layer),
            ),
        );

        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        expect(result.artifact_path).toBeUndefined();
        expect(existsSync(result.task_path!)).toBe(true);

        const body = readFileSync(result.task_path!, "utf-8");
        expect(body).toContain("form=guidance");
        // Full sig must appear in the marker; a truncated 8-char slice must not
        expect(body).toContain(`<!--ax:${longSig}-->`);
        // Regression guard: truncated form must not appear as a standalone marker
        expect(body).not.toContain(`<!--ax:${longSig.slice(0, 8)}-->`);
    });

    test("skill form defaults to task emission (no autoScaffold)", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        // dedupe_sig is LONGER than 8 chars to catch shortId truncation bugs
        const longSig = "skill__abcdef12345";
        const proposalRow = {
            id: "proposal:skill1",
            form: "skill",
            title: "Pre-Bash guard skill",
            hypothesis: "Bash failed 7 times",
            dedupe_sig: longSig,
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
            acceptProposal({ sigOrId: longSig, taskDir }).pipe(
                Effect.provide(layer),
            ),
        );

        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        expect(result.artifact_path).toBeUndefined();
        expect(existsSync(result.task_path!)).toBe(true);

        const body = readFileSync(result.task_path!, "utf-8");
        expect(body).toContain("form=skill");
        // Full sig must appear in the frontmatter; a truncated 8-char slice must not
        expect(body).toContain(`ax_id: ${longSig}`);
        // Regression guard: the truncated form must not appear as the standalone ax_id value
        expect(body).not.toContain(`ax_id: ${longSig.slice(0, 8)}\n`);
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

    test("subagent form emits a task brief", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: "proposal:subagent1",
            form: "subagent",
            title: "Review specialist",
            hypothesis: "Reviews recur with the same bounded role",
            dedupe_sig: "subagent_sig",
            status: "open",
            skill_payload: null,
            subagent_payload: {
                bounded_role: "Review TypeScript changes",
                delegation_trigger: "Large TypeScript diff",
                example_task_patterns: ["review this diff"],
            },
            guidance_payload: null,
        };
        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: "subagent_sig", taskDir }).pipe(
                Effect.provide(fakeRowsLayer([[[proposalRow]], [[]]])),
            ),
        );
        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        const body = readFileSync(result.task_path!, "utf-8");
        expect(body).toContain("form=subagent");
        expect(body).toContain("ax_id: subagent_sig");
    });

    test("hook form with complete safety contract emits a task brief", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: "proposal:hook1",
            form: "hook",
            title: "Pre-Bash guard hook",
            hypothesis: "Bash failures recur",
            dedupe_sig: "hook_sig",
            status: "open",
            skill_payload: null,
            hook_payload: {
                event_name: "PreToolUse",
                target_tool: "Bash",
                hook_command: "bash ~/.claude/hooks/pre-bash-guard.sh",
                recovery_path: "Remove hook from settings.json",
                smoke_test_command: "bun test src/improve/lifecycle.test.ts",
                disable_command: "mv hook.sh hook.sh.disabled",
                failure_mode: "fail_open",
            },
            guidance_payload: null,
        };
        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: "hook_sig", taskDir }).pipe(
                Effect.provide(fakeRowsLayer([[[proposalRow]], [[]]])),
            ),
        );
        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        const body = readFileSync(result.task_path!, "utf-8");
        expect(body).toContain("form=hook");
        expect(body).toContain("echo 'ax:hook_sig'");
        expect(body).toContain("Recovery Path: Remove hook from settings.json");
    });

    test("hook form without complete safety contract is rejected before task emission", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: "proposal:hook2",
            form: "hook",
            title: "Unsafe hook",
            hypothesis: "Missing safety gates",
            dedupe_sig: "unsafe_hook",
            status: "open",
            skill_payload: null,
            hook_payload: {
                event_name: "PreToolUse",
                target_tool: "Bash",
                hook_command: "bash hook.sh",
                recovery_path: null,
                smoke_test_command: null,
                disable_command: null,
                failure_mode: null,
            },
            guidance_payload: null,
        };
        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: "unsafe_hook", taskDir }).pipe(
                Effect.provide(fakeRowsLayer([[[proposalRow]]])),
            ),
        );
        expect(result.status).toBe("unsupported_form");
        expect(result.message).toContain("Recovery Path");
    });

    test("automation form with complete safety contract emits a task brief", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const proposalRow = {
            id: "proposal:auto1",
            form: "automation",
            title: "Weekly cleanup",
            hypothesis: "Cleanup should happen on a schedule",
            dedupe_sig: "automation_sig",
            status: "open",
            skill_payload: null,
            automation_payload: {
                trigger_signal: "weekly",
                schedule: "0 9 * * 1",
                action: "bun run cleanup",
                recovery_path: "Unload the LaunchAgent",
                smoke_test_command: "bun test src/improve/lifecycle.test.ts",
                disable_command: "launchctl unload ~/Library/LaunchAgents/com.ax.weekly.plist",
                failure_mode: "fail_open",
            },
            guidance_payload: null,
        };
        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: "automation_sig", taskDir }).pipe(
                Effect.provide(fakeRowsLayer([[[proposalRow]], [[]]])),
            ),
        );
        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        const body = readFileSync(result.task_path!, "utf-8");
        expect(body).toContain("form=automation");
        expect(body).toContain("<!-- ax:automation_sig experiment:");
        expect(body).toContain("bun run cleanup");
    });

    test("dedupe_sig with path separator characters is rejected", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const badRow = {
            id: { tb: "proposal", id: "guid_evil" },
            form: "guidance",
            title: "x",
            hypothesis: "y",
            dedupe_sig: "../../etc/passwd",
            status: "open",
            skill_payload: null,
            guidance_payload: { file_target: "~/.claude/CLAUDE.md", suggested_text: "z" },
        };
        const program = acceptProposal({ sigOrId: "../../etc/passwd", taskDir });
        let threw = false;
        try {
            await Effect.runPromise(
                program.pipe(Effect.provide(fakeRowsLayer([[[badRow]], []]))),
            );
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
    });

    test("two acceptProposal calls in quick succession produce distinct experiment keys", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-task-"));
        const row = {
            id: { tb: "proposal", id: "guid_concurrent" },
            form: "guidance",
            title: "x",
            hypothesis: "y",
            dedupe_sig: "concurrent_sig",
            status: "open",
            skill_payload: null,
            guidance_payload: { file_target: "~/.claude/CLAUDE.md", suggested_text: "z" },
        };
        const r1 = await Effect.runPromise(
            acceptProposal({ sigOrId: "concurrent_sig", taskDir, force: true })
                .pipe(Effect.provide(fakeRowsLayer([[[row]], []]))),
        );
        const r2 = await Effect.runPromise(
            acceptProposal({ sigOrId: "concurrent_sig", taskDir, force: true })
                .pipe(Effect.provide(fakeRowsLayer([[[row]], []]))),
        );
        expect(r1.experiment_id).not.toBe(r2.experiment_id);
    });
});

/** Layer that succeeds for queries matching `selectPattern`, fails for all others. */
const fakeRowsLayerWithFailure = (
    fixtures: ReadonlyArray<unknown[]>,
    failPattern: RegExp,
) => {
    let i = 0;
    return Layer.succeed(SurrealClient, {
        query: <T>(sql: string): Effect.Effect<T, DbError> => {
            if (failPattern.test(sql)) {
                return Effect.fail(new DbError({ operation: "query", message: "simulated DB failure", sql }));
            }
            return Effect.sync(() => (fixtures[i++] ?? []) as unknown as T);
        },
    } as never);
};

describe("acceptProposal - atomic write on DB failure", () => {
    test("DB failure after tmp write → neither taskPath nor tmpPath exists", async () => {
        const taskDir = mkdtempSync(join(tmpdir(), "ax-atomic-"));
        const longSig = "guidance__atomic99";
        const proposalRow = {
            id: "proposal:atm1",
            form: "guidance",
            title: "Atomic write test",
            hypothesis: "Verify tmp cleanup on DB failure",
            dedupe_sig: longSig,
            status: "open",
            skill_payload: null,
            guidance_payload: {
                file_target: "~/.claude/CLAUDE.md",
                section: null,
                suggested_text: "Use atomic writes.",
            },
        };

        // SELECT query succeeds (returns proposalRow); UPDATE+UPSERT query fails
        const layer = fakeRowsLayerWithFailure([[[proposalRow]]], /UPSERT/);

        const result = await Effect.runPromise(
            acceptProposal({ sigOrId: longSig, taskDir }).pipe(
                Effect.provide(layer),
                Effect.exit,
            ),
        );

        // Effect must have failed
        expect(result._tag).toBe("Failure");

        // Neither the final task file nor any tmp file should exist in taskDir
        const taskPath = join(taskDir, `${longSig}.md`);
        expect(existsSync(taskPath)).toBe(false);
        const remaining = readdirSync(taskDir).filter((f) => f.includes(longSig));
        expect(remaining).toHaveLength(0);
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
