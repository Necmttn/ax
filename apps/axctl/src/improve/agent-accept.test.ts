import { describe, expect, test } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, FileSystem, Layer } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Judgment, JudgmentLayer, type JudgmentService } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { buildAgentAcceptPrompt } from "./agent-accept.ts";
import { acceptProposal, shouldScaffoldWorkflowSkill } from "./actions.ts";
import { findStoredProposal } from "./judgment-proposals.ts";

type ProposalFixture = {
    readonly id: string;
    readonly form: "guidance" | "skill" | "subagent" | "hook" | "automation" | "harness_check";
    readonly title: string;
    readonly hypothesis: string;
    readonly dedupe_sig: string;
    readonly frequency?: number;
    readonly confidence?: string;
    readonly baseline?: string | null;
    readonly skill_payload?: Readonly<Record<string, unknown>>;
    readonly subagent_payload?: Readonly<Record<string, unknown>>;
    readonly hook_payload?: Readonly<Record<string, unknown>>;
    readonly guidance_payload?: Readonly<Record<string, unknown>>;
    readonly automation_payload?: Readonly<Record<string, unknown>>;
};

const seedProposal = (judgment: JudgmentService, row: ProposalFixture) =>
    Effect.gen(function* () {
        const now = new Date("2026-01-01T00:00:00Z");
        yield* judgment.put("proposal", {
            id: row.id,
            form: row.form,
            title: row.title,
            hypothesis: row.hypothesis,
            dedupe_sig: row.dedupe_sig,
            frequency: row.frequency ?? 1,
            confidence: row.confidence ?? "high",
            status: "open",
            origin: "agent",
            hypothesis_template: null,
            evidence_query: null,
            reject_reason: null,
            baseline: row.baseline ?? null,
            created_at: now,
            updated_at: now,
        });
        for (const table of ["skill", "subagent", "hook", "guidance", "automation"] as const) {
            const payload = row[`${table}_payload`];
            if (payload) {
                yield* judgment.put(`${table}_proposal`, {
                    id: `${table}-${row.id}`,
                    proposal: row.id,
                    ...payload,
                });
            }
        }
    });

type SidecarBody<A> = (
    judgment: JudgmentService,
    root: string,
) => Effect.Effect<A, unknown, Judgment | FileSystem.FileSystem>;

/**
 * One run against the sidecar file in `root`. Each call opens its own layer, so
 * two calls over the same root are two independent processes as far as the
 * SQLite file is concerned - which is what a retry after a crash looks like.
 */
const runInRoot = <A>(root: string, body: SidecarBody<A>, schemaSuffix = ""): Promise<A> => {
    const layer = Layer.mergeAll(
        JudgmentLayer({ sidecarPath: join(root, "judgment.sqlite"), schemaSql: `${SIDECAR_SCHEMA_SQL}\n${schemaSuffix}` }),
        BunFileSystem.layer,
        BunPath.layer,
    );
    return Effect.runPromise(Effect.gen(function* () {
        const judgment = yield* Judgment;
        return yield* body(judgment, root);
    }).pipe(Effect.provide(layer), Effect.scoped));
};

const runWithProposal = <A>(
    row: ProposalFixture,
    body: SidecarBody<A>,
    schemaSuffix = "",
): Promise<A> => {
    const root = mkdtempSync(join(tmpdir(), "ax-accept-sidecar-"));
    return runInRoot(root, (judgment, dir) => Effect.gen(function* () {
        yield* seedProposal(judgment, row);
        return yield* body(judgment, dir);
    }), schemaSuffix);
};

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

describe("acceptProposal with real SQLite", () => {
    test("writes a guidance task with the complete stable marker", async () => {
        const sig = "guidance__abcdef12345";
        const result = await runWithProposal({
            id: "guidance-one",
            form: "guidance",
            title: "Use rg",
            hypothesis: "Search is slow.",
            dedupe_sig: sig,
            frequency: 4,
            guidance_payload: {
                file_target: "CLAUDE.md",
                section: "tools",
                suggested_text: "Use rg.",
            },
        }, (_judgment, root) => acceptProposal({ sigOrId: sig, taskDir: root }));

        expect(result.status).toBe("ok");
        expect(result.task_path).toBeDefined();
        const body = readFileSync(result.task_path!, "utf8");
        expect(body).toContain(`<!--ax:${sig}-->`);
        expect(body).not.toContain(`<!--ax:${sig.slice(0, 8)}-->`);
    });

    test("scaffolds a skill only when direct scaffold is requested", async () => {
        const result = await runWithProposal({
            id: "skill-one",
            form: "skill",
            title: "Guard Bash",
            hypothesis: "Bash fails.",
            dedupe_sig: "guard_bash",
            skill_payload: {
                trigger_pattern: "tool=Bash",
                suspected_gap: "no validation",
                proposed_behavior: "validate first",
                expected_impact: "fewer failures",
            },
        }, (_judgment, root) => acceptProposal({
            sigOrId: "guard_bash",
            autoScaffold: true,
            scaffoldBaseDir: root,
        }));

        expect(result.status).toBe("ok");
        expect(result.artifact_path).toEndWith("/guard-bash/SKILL.md");
        expect(existsSync(result.artifact_path!)).toBe(true);
        expect(result.task_path).toBeUndefined();
    });

    test("requires the complete hook safety contract", async () => {
        const unsafe = await runWithProposal({
            id: "hook-unsafe",
            form: "hook",
            title: "Unsafe hook",
            hypothesis: "A guard is useful.",
            dedupe_sig: "unsafe_hook",
            hook_payload: {
                event_name: "PreToolUse",
                target_tool: "Bash",
                hook_command: "bash hook.sh",
                recovery_path: null,
                smoke_test_command: null,
                disable_command: null,
                failure_mode: null,
            },
        }, (_judgment, root) => acceptProposal({ sigOrId: "unsafe_hook", taskDir: root }));
        expect(unsafe.status).toBe("unsupported_form");
        expect(unsafe.message).toContain("Recovery Path");

        const safe = await runWithProposal({
            id: "hook-safe",
            form: "hook",
            title: "Safe hook",
            hypothesis: "A guard is useful.",
            dedupe_sig: "safe_hook",
            hook_payload: {
                event_name: "PreToolUse",
                target_tool: "Bash",
                hook_command: "bash hook.sh",
                recovery_path: "remove the hook",
                smoke_test_command: "bun test",
                disable_command: "mv hook.sh hook.disabled",
                failure_mode: "fail_open",
            },
        }, (_judgment, root) => acceptProposal({ sigOrId: "safe_hook", taskDir: root }));
        expect(safe.status).toBe("ok");
        expect(readFileSync(safe.task_path!, "utf8")).toContain("Recovery Path: remove the hook");
    });

    test("writes a subagent task from its sidecar payload", async () => {
        const result = await runWithProposal({
            id: "subagent-one",
            form: "subagent",
            title: "Review migrations",
            hypothesis: "Migration reviews need a bounded role.",
            dedupe_sig: "migration_reviewer",
            subagent_payload: {
                bounded_role: "Review schema migrations only.",
                delegation_trigger: "A change includes a migration.",
            },
        }, (_judgment, root) => acceptProposal({ sigOrId: "migration_reviewer", taskDir: root }));

        expect(result.status).toBe("ok");
        const body = readFileSync(result.task_path!, "utf8");
        expect(body).toContain("form=subagent");
        expect(body).toContain("Role: Review schema migrations only.");
        expect(body).toContain("Delegation trigger: A change includes a migration.");
    });

    test("writes a harness check task with baseline evidence", async () => {
        const result = await runWithProposal({
            id: "harness-one",
            form: "harness_check",
            title: "Check offline startup",
            hypothesis: "The command must work without SurrealDB.",
            dedupe_sig: "offline_startup",
            baseline: "The old command connects to port 8521.",
        }, (_judgment, root) => acceptProposal({ sigOrId: "offline_startup", taskDir: root }));

        expect(result.status).toBe("ok");
        const body = readFileSync(result.task_path!, "utf8");
        expect(body).toContain("form=harness_check");
        expect(body).toContain("The command must work without SurrealDB.");
        expect(body).toContain("Baseline evidence:\nThe old command connects to port 8521.");
    });

    test("requires the complete automation safety contract", async () => {
        const unsafe = await runWithProposal({
            id: "automation-unsafe",
            form: "automation",
            title: "Unsafe automation",
            hypothesis: "A schedule can reduce manual work.",
            dedupe_sig: "unsafe_automation",
            automation_payload: {
                trigger_signal: "new transcript",
                action: "ax ingest",
                schedule: "hourly",
                recovery_path: "remove the schedule",
                smoke_test_command: null,
                disable_command: null,
                failure_mode: null,
            },
        }, (_judgment, root) => acceptProposal({ sigOrId: "unsafe_automation", taskDir: root }));
        expect(unsafe.status).toBe("unsupported_form");
        expect(unsafe.message).toContain("smoke test");
        expect(unsafe.message).toContain("disable switch");
        expect(unsafe.message).toContain("failure mode");

        const safe = await runWithProposal({
            id: "automation-safe",
            form: "automation",
            title: "Safe automation",
            hypothesis: "A schedule can reduce manual work.",
            dedupe_sig: "safe_automation",
            automation_payload: {
                trigger_signal: "new transcript",
                action: "ax ingest",
                schedule: "hourly",
                recovery_path: "remove the schedule",
                smoke_test_command: "ax status",
                disable_command: "launchctl unload com.example.ax.plist",
                failure_mode: "fail_open",
            },
        }, (_judgment, root) => acceptProposal({ sigOrId: "safe_automation", taskDir: root }));
        expect(safe.status).toBe("ok");
        const body = readFileSync(safe.task_path!, "utf8");
        expect(body).toContain("form=automation");
        expect(body).toContain("Recovery Path: remove the schedule");
        expect(body).toContain("Smoke Test: ax status");
        expect(body).toContain("Disable Switch: launchctl unload com.example.ax.plist");
        expect(body).toContain("Failure Mode: fail_open");
    });

    test("cleans the temporary task when the SQLite transaction fails", async () => {
        const sig = "atomic_failure";
        const result = await runWithProposal({
            id: "atomic-one",
            form: "guidance",
            title: "Atomic task",
            hypothesis: "Writes must be atomic.",
            dedupe_sig: sig,
            guidance_payload: {
                file_target: "CLAUDE.md",
                section: null,
                suggested_text: "Use atomic writes.",
            },
        }, (_judgment, root) => Effect.gen(function* () {
            const exit = yield* acceptProposal({ sigOrId: sig, taskDir: root }).pipe(Effect.exit);
            return { exit, root };
        }), `CREATE TRIGGER fail_experiment BEFORE INSERT ON experiment
             BEGIN SELECT RAISE(FAIL, 'simulated SQLite failure'); END;`);

        expect(result.exit._tag).toBe("Failure");
        expect(existsSync(join(result.root, `${sig}.md`))).toBe(false);
        expect(readdirSync(result.root).filter((name) => name.includes(`${sig}.md.tmp.`))).toHaveLength(0);
    });

    test("uses different stable experiment IDs for different proposals", async () => {
        const first = await runWithProposal({
            id: "id-one",
            form: "guidance",
            title: "One",
            hypothesis: "One.",
            dedupe_sig: "unique_one",
            guidance_payload: { file_target: "CLAUDE.md", section: null, suggested_text: "One." },
        }, (_judgment, root) => acceptProposal({ sigOrId: "unique_one", taskDir: root }));
        const second = await runWithProposal({
            id: "id-two",
            form: "guidance",
            title: "Two",
            hypothesis: "Two.",
            dedupe_sig: "unique_two",
            guidance_payload: { file_target: "CLAUDE.md", section: null, suggested_text: "Two." },
        }, (_judgment, root) => acceptProposal({ sigOrId: "unique_two", taskDir: root }));
        expect(first.experiment_id).not.toBe(second.experiment_id);
    });

    test("rejects a proposal marker that contains path separators", async () => {
        const result = await runWithProposal({
            id: "unsafe-path",
            form: "guidance",
            title: "Unsafe path",
            hypothesis: "The marker is unsafe.",
            dedupe_sig: "../../outside",
            guidance_payload: { file_target: "CLAUDE.md", section: null, suggested_text: "Text." },
        }, (_judgment, root) => Effect.gen(function* () {
            const exit = yield* acceptProposal({ sigOrId: "../../outside", taskDir: root }).pipe(Effect.exit);
            return { exit, root };
        }));
        expect(result.exit._tag).toBe("Failure");
        expect(readdirSync(result.root).filter((name) => name.endsWith(".md"))).toHaveLength(0);
    });
});

describe("acceptProposal publication recovery", () => {
    const sig = "resume_publication";
    const fixture: ProposalFixture = {
        id: "resume-one",
        form: "guidance",
        title: "Use rg",
        hypothesis: "Search is slow.",
        dedupe_sig: sig,
        guidance_payload: { file_target: "CLAUDE.md", section: "tools", suggested_text: "Use rg." },
    };

    /**
     * Interrupt a publication for real: a directory sits on the task path, so the
     * write and the accept transaction both succeed and only the rename fails.
     * Nothing here is mocked - the fault is in the filesystem the code really uses.
     */
    const interruptPublication = async (): Promise<string> => {
        const root = mkdtempSync(join(tmpdir(), "ax-accept-resume-"));
        await runInRoot(root, (judgment) => seedProposal(judgment, fixture));
        mkdirSync(join(root, `${sig}.md`));
        const exit = await runInRoot(root, () =>
            acceptProposal({ sigOrId: sig, taskDir: root, force: true }).pipe(Effect.exit));
        expect(exit._tag).toBe("Failure");
        return root;
    };

    const storedState = (root: string) =>
        runInRoot(root, () => Effect.gen(function* () {
            const stored = yield* findStoredProposal(sig);
            return {
                proposalStatus: stored?.status ?? null,
                experimentId: stored?.experiment?.id ?? null,
                experimentStatus: stored?.experiment?.status ?? null,
                taskPath: stored?.experiment?.task_path ?? null,
            };
        }));

    test("keeps the experiment publishing when the rename fails after the commit", async () => {
        const root = await interruptPublication();
        const state = await storedState(root);
        expect(state.proposalStatus).toBe("accepted");
        expect(state.experimentStatus).toBe("publishing");
        expect(state.taskPath).toBe(join(root, `${sig}.md`));
        expect(existsSync(join(root, `${sig}.md`, "anything"))).toBe(false);
    });

    test("finishes the interrupted publication on a process-style retry", async () => {
        const root = await interruptPublication();
        const before = await storedState(root);
        rmSync(join(root, `${sig}.md`), { recursive: true });

        const retry = await runInRoot(root, () => acceptProposal({ sigOrId: sig, taskDir: root }));

        expect(retry.status).toBe("ok");
        expect(retry.task_path).toBe(join(root, `${sig}.md`));
        const body = readFileSync(retry.task_path!, "utf8");
        expect(body).toContain(`<!--ax:${sig}-->`);
        expect(body).toContain("Use rg.");
        const after = await storedState(root);
        expect(after.experimentId).toBe(before.experimentId);
        expect(retry.experiment_id).toBe(`experiment:${before.experimentId}`);
        expect(after.experimentStatus).toBe("task_emitted");
        expect(after.taskPath).toBe(before.taskPath);
        expect(readdirSync(root).filter((name) => name.includes(`${sig}.md.tmp.`))).toHaveLength(0);
    });

    test("refuses a repeated retry once the publication is complete", async () => {
        const root = await interruptPublication();
        rmSync(join(root, `${sig}.md`), { recursive: true });
        await runInRoot(root, () => acceptProposal({ sigOrId: sig, taskDir: root }));
        const body = readFileSync(join(root, `${sig}.md`), "utf8");

        const again = await runInRoot(root, () => acceptProposal({ sigOrId: sig, taskDir: root }));

        expect(again.status).toBe("wrong_status");
        expect(again.message).toBe("proposal already accepted");
        expect(again.existing_experiment?.id).toBeDefined();
        expect(readFileSync(join(root, `${sig}.md`), "utf8")).toBe(body);
    });

    test("never overwrites a brief that is already on disk", async () => {
        const root = await interruptPublication();
        rmSync(join(root, `${sig}.md`), { recursive: true });
        writeFileSync(join(root, `${sig}.md`), "operator edit\n");

        const retry = await runInRoot(root, () => acceptProposal({ sigOrId: sig, taskDir: root }));

        expect(retry.status).toBe("ok");
        expect(readFileSync(join(root, `${sig}.md`), "utf8")).toBe("operator edit\n");
        expect((await storedState(root)).experimentStatus).toBe("task_emitted");
    });

    test("finishes the brief even when the retry asks for a direct scaffold", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-accept-resume-skill-"));
        const skillSig = "resume_skill";
        await runInRoot(root, (judgment) => seedProposal(judgment, {
            id: "resume-skill",
            form: "skill",
            title: "Guard Bash",
            hypothesis: "Bash fails.",
            dedupe_sig: skillSig,
            skill_payload: {
                trigger_pattern: "tool=Bash",
                suspected_gap: "no validation",
                proposed_behavior: "validate first",
                expected_impact: "fewer failures",
            },
        }));
        mkdirSync(join(root, `${skillSig}.md`));
        await runInRoot(root, () =>
            acceptProposal({ sigOrId: skillSig, taskDir: root, force: true }).pipe(Effect.exit));
        rmSync(join(root, `${skillSig}.md`), { recursive: true });

        const retry = await runInRoot(root, () => acceptProposal({
            sigOrId: skillSig,
            taskDir: root,
            autoScaffold: true,
            scaffoldBaseDir: join(root, "skills"),
        }));

        expect(retry.status).toBe("ok");
        expect(retry.task_path).toBe(join(root, `${skillSig}.md`));
        expect(existsSync(join(root, "skills"))).toBe(false);
        const stored = await runInRoot(root, () => findStoredProposal(skillSig));
        expect(stored?.experiment?.status).toBe("task_emitted");
    });

    test("does not revive an experiment a verdict already judged", async () => {
        const root = await interruptPublication();
        rmSync(join(root, `${sig}.md`), { recursive: true });
        await runInRoot(root, (judgment) =>
            judgment.exec("UPDATE experiment SET locked_verdict = ? WHERE status = ?", ["adopted", "publishing"]));

        const retry = await runInRoot(root, () => acceptProposal({ sigOrId: sig, taskDir: root }));

        expect(retry.status).toBe("wrong_status");
        expect(existsSync(join(root, `${sig}.md`))).toBe(false);
        expect((await storedState(root)).experimentStatus).toBe("publishing");
    });
});

describe("shouldScaffoldWorkflowSkill", () => {
    test("accepts only workflow guidance", () => {
        expect(shouldScaffoldWorkflowSkill({ form: "guidance", guidance_payload: { section: "workflows" } })).toBe(true);
        expect(shouldScaffoldWorkflowSkill({ form: "guidance", guidance_payload: { section: "directives" } })).toBe(false);
        expect(shouldScaffoldWorkflowSkill({ form: "skill" })).toBe(false);
    });
});
