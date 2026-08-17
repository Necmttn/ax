import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { judgmentTestLayer } from "../testing/judgment-test-layer.ts";
import {
    buildRetroPlanKeys,
    cmdRetroPlan,
    parseRetroPlanArgs,
    type RetroPlanArgs,
} from "./retro-plan.ts";
import { dedupeSig, normalizeTitle } from "../ingest/derive-proposals.ts";

const baseArgs = (overrides: Partial<RetroPlanArgs> = {}): RetroPlanArgs => ({
    slug: "test-slug",
    form: "skill",
    title: "Pre-Bash guard refinement",
    hypothesis: "Bash failures cluster around missing-dir errors.",
    planPath: "/tmp/ax-plan.md",
    evidenceRetros: ["retro:r1", "retro:r2"],
    artifactPath: null,
    confidence: "medium",
    frequency: 3,
    json: true,
    safety: {
        recoveryPath: null,
        smokeTestCommand: null,
        disableCommand: null,
        failureMode: null,
    },
    leaveOpen: false,
    ...overrides,
});

describe("parseRetroPlanArgs", () => {
    test("parses all flags into a normalized struct", () => {
        const parsed = parseRetroPlanArgs(
            [
                "--slug=foo",
                "--form=guidance",
                "--title=My guidance",
                "--hypothesis=Some hyp",
                "--plan-path=/dev/null",
                "--evidence-retros=retro:a,retro:b",
                "--artifact-path=/tmp/art.md",
                "--confidence=high",
                "--frequency=5",
                "--recovery-path=Move generated hook out of ~/.claude/settings.json",
                "--smoke-test-command=bun test src/improve/lifecycle.test.ts",
                "--disable-command=mv hook.sh hook.sh.disabled",
                "--failure-mode=fail_open",
                "--json",
            ],
            { checkPlanPath: false },
        );
        expect(parsed.slug).toBe("foo");
        expect(parsed.form).toBe("guidance");
        expect(parsed.title).toBe("My guidance");
        expect(parsed.evidenceRetros).toEqual(["retro:a", "retro:b"]);
        expect(parsed.artifactPath).toBe("/tmp/art.md");
        expect(parsed.confidence).toBe("high");
        expect(parsed.frequency).toBe(5);
        expect(parsed.safety).toEqual({
            recoveryPath: "Move generated hook out of ~/.claude/settings.json",
            smokeTestCommand: "bun test src/improve/lifecycle.test.ts",
            disableCommand: "mv hook.sh hook.sh.disabled",
            failureMode: "fail_open",
        });
        expect(parsed.json).toBe(true);
    });

    test("rejects missing required flags by exiting", () => {
        const origExit = process.exit;
        const origErr = console.error;
        let exited = false;
        (process as { exit: unknown }).exit = ((code?: number) => {
            exited = true;
            throw new Error(`exited:${code ?? 0}`);
        }) as never;
        console.error = () => undefined;
        try {
            expect(() =>
                parseRetroPlanArgs(
                    ["--form=skill", "--title=t", "--hypothesis=h", "--plan-path=/dev/null"],
                    { checkPlanPath: false },
                )
            ).toThrow();
            expect(exited).toBe(true);
        } finally {
            process.exit = origExit;
            console.error = origErr;
        }
    });

    test("defaults frequency=1 and confidence=medium when omitted", () => {
        const parsed = parseRetroPlanArgs(
            [
                "--slug=s",
                "--form=skill",
                "--title=t",
                "--hypothesis=h",
                "--plan-path=/dev/null",
            ],
            { checkPlanPath: false },
        );
        expect(parsed.frequency).toBe(1);
        expect(parsed.confidence).toBe("medium");
        expect(parsed.evidenceRetros).toEqual([]);
    });

    test("rejects invalid form", () => {
        const origExit = process.exit;
        const origErr = console.error;
        (process as { exit: unknown }).exit = ((code?: number) => {
            throw new Error(`exited:${code ?? 0}`);
        }) as never;
        console.error = () => undefined;
        try {
            expect(() =>
                parseRetroPlanArgs(
                    ["--slug=s", "--form=bogus", "--title=t", "--hypothesis=h", "--plan-path=/dev/null"],
                    { checkPlanPath: false },
                )
            ).toThrow();
        } finally {
            process.exit = origExit;
            console.error = origErr;
        }
    });

    test("rejects invalid failure mode", () => {
        const origExit = process.exit;
        const origErr = console.error;
        (process as { exit: unknown }).exit = ((code?: number) => {
            throw new Error(`exited:${code ?? 0}`);
        }) as never;
        console.error = () => undefined;
        try {
            expect(() =>
                parseRetroPlanArgs(
                    [
                        "--slug=s",
                        "--form=hook",
                        "--title=t",
                        "--hypothesis=h",
                        "--plan-path=/dev/null",
                        "--failure-mode=block",
                    ],
                    { checkPlanPath: false },
                )
            ).toThrow();
        } finally {
            process.exit = origExit;
            console.error = origErr;
        }
    });
});

describe("buildRetroPlanKeys dedupeSig", () => {
    test("matches dedupeSig(form, normalizeTitle(title)) from derive-proposals", () => {
        const args = baseArgs();
        const built = buildRetroPlanKeys(args, 1_700_000_000_000);
        const expectedSig = dedupeSig(args.form, normalizeTitle(args.title));
        expect(built.sig).toBe(expectedSig);
    });
});

describe("buildRetroPlanKeys derivations", () => {
    test("proposal and experiment keys are stable content hashes", () => {
        const first = buildRetroPlanKeys(baseArgs(), 1_700_000_000_000);
        const second = buildRetroPlanKeys(baseArgs(), 1_800_000_000_000);
        expect(first.proposalKey).toMatch(/^[0-9a-f]{32}$/);
        expect(first.experimentKey).toMatch(/^[0-9a-f]{32}$/);
        expect(second.proposalKey).toBe(first.proposalKey);
        expect(second.experimentKey).toBe(first.experimentKey);
    });

    test("--leave-open: proposal status is 'open' (not 'accepted')", () => {
        const built = buildRetroPlanKeys(
            baseArgs({ leaveOpen: true }),
            1_700_000_000_000,
        );
        expect(built.proposalStatus).toBe("open");
    });

    test("--leave-open: no experiment key, so cmdRetroPlan writes no experiment row", () => {
        const built = buildRetroPlanKeys(
            baseArgs({ leaveOpen: true }),
            1_700_000_000_000,
        );
        expect(built.experimentKey).toBeNull();
    });

    test("parseRetroPlanArgs picks up --leave-open", () => {
        const parsed = parseRetroPlanArgs(
            [
                "--slug=s",
                "--form=skill",
                "--title=t",
                "--hypothesis=h",
                "--plan-path=/dev/null",
                "--leave-open",
            ],
            { checkPlanPath: false },
        );
        expect(parsed.leaveOpen).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// What `ax retro plan` actually WRITES.
//
// These tests replace an older block that asserted on SurrealQL statement text
// returned by the builder. That text was never executed - `cmdRetroPlan` writes
// through `judgment.transaction`, field by field - so the assertions proved
// only that a dead string had the right shape. The behaviour they were
// standing in for (which payload table each form writes, whether an experiment
// row appears) is real, so it is asserted here against the live write path.
// ---------------------------------------------------------------------------

describe("cmdRetroPlan writes", () => {
    const planPath = `${tmpdir()}/ax-retro-plan-test.md`;

    /** Run the command against a recording Judgment; return the tables written, in order. */
    const writesFor = async (argv: readonly string[]): Promise<Array<{ table: string; row: Record<string, unknown> }>> => {
        await Bun.write(planPath, "# plan\n");
        const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
        const log = console.log;
        console.log = () => {};
        try {
            await Effect.runPromise(
                cmdRetroPlan([...argv, `--plan-path=${planPath}`]).pipe(
                    Effect.provide(judgmentTestLayer(() => [], () => 0, (table, row) => {
                        writes.push({ table, row: row as Record<string, unknown> });
                    })),
                    Effect.provide(BunFileSystem.layer),
                ),
            );
        } finally {
            console.log = log;
        }
        return writes;
    };

    const argvFor = (form: string, extra: readonly string[] = []): readonly string[] => [
        "--slug=test-slug",
        `--form=${form}`,
        "--title=Pre-Bash guard refinement",
        "--hypothesis=Bash failures cluster around missing-dir errors.",
        ...extra,
    ];

    test("skill form writes proposal + skill_proposal + experiment", async () => {
        const writes = await writesFor(argvFor("skill"));
        expect(writes.map((w) => w.table)).toEqual(["proposal", "skill_proposal", "experiment"]);
        expect(writes[0]!.row.status).toBe("accepted");
        expect(writes[0]!.row.form).toBe("skill");
    });

    test("guidance form writes a guidance_proposal payload targeting CLAUDE.md", async () => {
        const writes = await writesFor(argvFor("guidance"));
        expect(writes.map((w) => w.table)).toEqual(["proposal", "guidance_proposal", "experiment"]);
        expect(writes[1]!.row.file_target).toBe("CLAUDE.md");
    });

    test("hook form writes a hook_proposal carrying its safety gates", async () => {
        const writes = await writesFor(argvFor("hook", [
            "--recovery-path=Remove the hook entry from settings.json",
            "--smoke-test=bun test src/improve/lifecycle.test.ts",
            "--disable-command=mv hook.sh hook.sh.disabled",
            "--failure-mode=fail_open",
        ]));
        expect(writes.map((w) => w.table)).toEqual(["proposal", "hook_proposal"]);
        expect(writes[1]!.row.event_name).toBe("PreToolUse");
        expect(writes[1]!.row.recovery_path).toBe("Remove the hook entry from settings.json");
        expect(writes[1]!.row.failure_mode).toBe("fail_open");
        // A hook proposal stays open, so no experiment row is scaffolded.
        expect(writes[0]!.row.status).toBe("open");
    });

    test("automation form writes an automation_proposal", async () => {
        const writes = await writesFor(argvFor("automation"));
        expect(writes.map((w) => w.table)).toContain("automation_proposal");
    });

    test("--leave-open writes no experiment row", async () => {
        const writes = await writesFor(argvFor("skill", ["--leave-open"]));
        expect(writes.map((w) => w.table)).toEqual(["proposal", "skill_proposal"]);
        expect(writes[0]!.row.status).toBe("open");
    });

    test("the experiment row prefers artifactPath over planPath", async () => {
        const writes = await writesFor(argvFor("skill", ["--artifact-path=/tmp/skill.md"]));
        const experiment = writes.find((w) => w.table === "experiment");
        expect(experiment?.row.artifact_path).toBe("/tmp/skill.md");
    });

    test("without --artifact-path the experiment row falls back to the plan path", async () => {
        const writes = await writesFor(argvFor("skill"));
        const experiment = writes.find((w) => w.table === "experiment");
        expect(experiment?.row.artifact_path).toBe(planPath);
    });
});
