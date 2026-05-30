import { describe, expect, test } from "bun:test";
import {
    buildRetroPlanStatements,
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
});

describe("buildRetroPlanStatements dedupeSig", () => {
    test("matches dedupeSig(form, normalizeTitle(title)) from derive-proposals", () => {
        const args = baseArgs();
        const built = buildRetroPlanStatements(args, 1_700_000_000_000);
        const expectedSig = dedupeSig(args.form, normalizeTitle(args.title));
        expect(built.sig).toBe(expectedSig);
    });
});

describe("buildRetroPlanStatements SQL shape", () => {
    test("emits CREATE proposal + payload + experiment", () => {
        const built = buildRetroPlanStatements(baseArgs(), 1_700_000_000_000);
        expect(built.statements.length).toBe(3);
        const sql = built.statements.join("\n");
        expect(sql).toMatch(/CREATE proposal:`[^`]+` CONTENT/);
        expect(sql).toMatch(/CREATE skill_proposal:`[^`]+` CONTENT/);
        expect(sql).toMatch(/CREATE experiment:`[^`]+` CONTENT/);
    });

    test("proposal row uses status='accepted'", () => {
        const built = buildRetroPlanStatements(baseArgs(), 1_700_000_000_000);
        expect(built.proposalStatus).toBe("accepted");
        expect(built.statements[0]).toContain('status: "accepted"');
    });

    test("baseline JSON embeds plan_path + evidence_retros", () => {
        const built = buildRetroPlanStatements(baseArgs(), 1_700_000_000_000);
        const proposalStmt = built.statements[0];
        expect(proposalStmt).toContain("plan_path");
        expect(proposalStmt).toContain("/tmp/ax-plan.md");
        expect(proposalStmt).toContain("retro:r1");
        expect(proposalStmt).toContain("retro:r2");
        expect(proposalStmt).toContain("retro_meta_plan");
    });

    test("guidance form writes guidance_proposal payload", () => {
        const built = buildRetroPlanStatements(
            baseArgs({ form: "guidance", title: "Add rule X" }),
            1,
        );
        expect(built.statements[1]).toMatch(/CREATE guidance_proposal:/);
        expect(built.statements[1]).toContain("file_target");
    });

    test("hook form writes hook_proposal payload", () => {
        const built = buildRetroPlanStatements(
            baseArgs({ form: "hook", title: "Pre-Bash guard hook" }),
            1,
        );
        expect(built.proposalStatus).toBe("open");
        expect(built.experimentKey).toBeNull();
        expect(built.safetyMessage).toContain("Recovery Path");
        expect(built.statements[1]).toMatch(/CREATE hook_proposal:/);
        expect(built.statements[1]).toContain("event_name");
        expect(built.statements.length).toBe(2);
    });

    test("automation form writes automation_proposal payload", () => {
        const built = buildRetroPlanStatements(
            baseArgs({ form: "automation", title: "Weekly cleanup" }),
            1,
        );
        expect(built.proposalStatus).toBe("open");
        expect(built.experimentKey).toBeNull();
        expect(built.safetyMessage).toContain("Recovery Path");
        expect(built.statements[1]).toMatch(/CREATE automation_proposal:/);
        expect(built.statements[1]).toContain("trigger_signal");
        expect(built.statements.length).toBe(2);
    });

    test("experiment row uses planPath when artifactPath is null", () => {
        const built = buildRetroPlanStatements(baseArgs({ artifactPath: null }), 1);
        const expStmt = built.statements[2];
        expect(expStmt).toContain("/tmp/ax-plan.md");
        expect(expStmt).toContain('status: "scaffolded"');
    });

    test("experiment row prefers artifactPath when provided", () => {
        const built = buildRetroPlanStatements(
            baseArgs({ artifactPath: "/tmp/skill.md" }),
            1,
        );
        const expStmt = built.statements[2];
        expect(expStmt).toContain("/tmp/skill.md");
    });

    test("proposal key + experiment key share the same slug-derived prefix", () => {
        const built = buildRetroPlanStatements(baseArgs(), 1_700_000_000_000);
        // Default (leaveOpen=false) always materialises an experiment key.
        expect(built.experimentKey).not.toBeNull();
        expect(built.experimentKey!.startsWith(built.proposalKey)).toBe(true);
    });

    test("--leave-open: proposal status is 'open' (not 'accepted')", () => {
        const built = buildRetroPlanStatements(
            baseArgs({ leaveOpen: true }),
            1_700_000_000_000,
        );
        expect(built.statements[0]).toContain('status: "open"');
        expect(built.statements[0]).not.toContain('status: "accepted"');
        expect(built.proposalStatus).toBe("open");
    });

    test("--leave-open: NO experiment row emitted", () => {
        const built = buildRetroPlanStatements(
            baseArgs({ leaveOpen: true }),
            1_700_000_000_000,
        );
        expect(built.experimentKey).toBeNull();
        const sql = built.statements.join("\n");
        expect(sql).not.toMatch(/UPSERT experiment:|CREATE experiment:/);
        // Still emits proposal + per-form payload (so accept later has data).
        expect(built.statements.length).toBe(2);
        expect(sql).toMatch(/CREATE proposal:`[^`]+` CONTENT/);
        expect(sql).toMatch(/CREATE skill_proposal:`[^`]+` CONTENT/);
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
