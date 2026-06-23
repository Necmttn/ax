import { describe, expect, test } from "bun:test";
import {
    buildGuidanceProposalStatements,
    buildImageContextProposalStatements,
    buildRoutingProposalStatements,
    buildSkillProposalStatements,
    dedupeSig,
    deriveDirectiveProposalRows,
    deriveGuidanceProposalRows,
    deriveImageContextProposalRow,
    deriveRoutingProposalRow,
    deriveSkillProposalRows,
    deriveWorkflowProposalRows,
    IMAGE_CONTEXT_THRESHOLD_MB,
    normalizeTitle,
    parseMetrics,
    skillProposalFrequency,
} from "./derive-proposals.ts";
import type { HarnessLearningCandidate } from "../project/types.ts";
import type { ImageContextResult } from "../queries/image-context.ts";

describe("derive-proposals helpers", () => {
    test("normalizeTitle lowercases + collapses whitespace", () => {
        expect(normalizeTitle("  Schema  Change   GUARDRAIL  ")).toBe("schema change guardrail");
    });

    test("dedupeSig is deterministic and form-scoped", () => {
        const a = dedupeSig("skill", "schema change guardrail");
        const b = dedupeSig("skill", "schema change guardrail");
        const c = dedupeSig("hook", "schema change guardrail");
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a.startsWith("skill__")).toBe(true);
    });

    test("parseMetrics tolerates string, object, null, undefined", () => {
        expect(parseMetrics(null)).toEqual({});
        expect(parseMetrics(undefined)).toEqual({});
        expect(parseMetrics({ fix_chain_count: 4 })).toEqual({ fix_chain_count: 4 });
        expect(parseMetrics('{"fix_chain_count":4}')).toEqual({ fix_chain_count: 4 });
        expect(parseMetrics("not-json")).toEqual({});
    });

    test("skillProposalFrequency uses fix_chain_count only - risky_session_count is noise, ignored", () => {
        expect(skillProposalFrequency({ fix_chain_count: 3, risky_session_count: 7 })).toBe(3);
        expect(skillProposalFrequency({ fix_chain_count: 9 })).toBe(9);
        expect(skillProposalFrequency({ risky_session_count: 1072 })).toBe(0);
        expect(skillProposalFrequency({})).toBe(0);
    });
});

describe("deriveSkillProposalRows", () => {
    const baseCandidate = {
        id: "skill_candidate:schema_change_guardrail",
        name: "Schema change guardrail",
        trigger_pattern: "schema file edit",
        suspected_gap: "no pre-edit validation",
        proposed_behavior: "run schema lint before edit",
        confidence: "high",
        expected_impact: "fewer broken migrations",
        metrics: { fix_chain_count: 5 },
    };

    test("skips candidates below minFrequency", () => {
        const { rows, skipped } = deriveSkillProposalRows(
            [{ ...baseCandidate, metrics: { fix_chain_count: 1 } }],
            new Set(),
            3,
        );
        expect(rows).toEqual([]);
        expect(skipped).toBe(1);
    });

    test("skips candidates whose normalized title matches an existing skill", () => {
        const { rows, skipped } = deriveSkillProposalRows(
            [baseCandidate],
            new Set(["schema change guardrail"]),
            3,
        );
        expect(rows).toEqual([]);
        expect(skipped).toBe(1);
    });

    test("emits a row with frozen frequency + dedupe_sig + payload fields", () => {
        const { rows, skipped } = deriveSkillProposalRows([baseCandidate], new Set(), 3);
        expect(skipped).toBe(0);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.title).toBe("Schema change guardrail");
        expect(row.frequency).toBe(5);
        expect(row.sig.startsWith("skill__")).toBe(true);
        expect(row.triggerPattern).toBe("schema file edit");
        expect(row.candidateKey).toBe("schema_change_guardrail");
    });
});

describe("buildSkillProposalStatements", () => {
    const baseRow = {
        proposalKey: "skill__schema_change_guardrail__abcdef123456",
        candidateKey: "schema_change_guardrail",
        title: "Schema change guardrail",
        hypothesis: "gap",
        triggerPattern: "schema file edit",
        suspectedGap: "no pre-edit validation",
        proposedBehavior: "run schema lint",
        expectedImpact: "fewer breaks",
        confidence: "high",
        frequency: 5,
        sig: "skill__abcdef123456",
        metrics: { fix_chain_count: 5 },
    };

    test("new sig: CREATE proposal with baseline + status='open'", () => {
        const sql = buildSkillProposalStatements([baseRow], new Set()).join("\n");
        expect(sql).toContain("CREATE proposal:");
        expect(sql).toContain("status: \"open\"");
        expect(sql).toContain("baseline:");
        expect(sql).toContain("dedupe_sig: \"skill__abcdef123456\"");
        expect(sql).toContain("UPSERT skill_proposal:");
        expect(sql).toContain("RELATE proposal:");
        expect(sql).toContain("->cites_evidence:");
    });

    test("existing sig: UPDATE refresh-able fields ONLY, no baseline/status touch", () => {
        const sql = buildSkillProposalStatements([baseRow], new Set([baseRow.sig])).join("\n");
        expect(sql).toContain("UPDATE proposal:");
        expect(sql).not.toContain("CREATE proposal:");
        expect(sql).not.toMatch(/\bstatus\s*=/);
        expect(sql).not.toMatch(/\bbaseline\s*=/);
        expect(sql).toMatch(/\bfrequency\s*=\s*5/);
        expect(sql).toMatch(/\bconfidence\s*=\s*"high"/);
        expect(sql).toContain("UPSERT skill_proposal:");
    });
});

describe("deriveDirectiveProposalRows (directive mining v1)", () => {
    const cand = (text: string, o: Partial<{ turnKey: string; ts: string; pattern: string }> = {}) => ({
        turnKey: o.turnKey ?? "t1",
        sessionId: "session:s1",
        text,
        pattern: o.pattern ?? "remember to",
        ts: o.ts ?? "2026-06-17T10:00:00.000Z",
    });

    test("aggregates frequency across identically-worded directives", () => {
        const { rows } = deriveDirectiveProposalRows([
            cand("Remember to dogfood before showing me.", { turnKey: "a" }),
            cand("Remember to dogfood before showing me.", { turnKey: "b", ts: "2026-06-18T00:00:00.000Z" }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.frequency).toBe(2);
        expect(rows[0]!.title).toBe("Directive: Remember to dogfood before showing me.");
        expect(rows[0]!.confidence).toBe("medium"); // freq 2
        expect(rows[0]!.evidenceSummary).toEqual(["turn:a", "turn:b"]);
    });

    test("emits guidance form with a stable dedupe sig (accumulates, not forks)", () => {
        const a = deriveDirectiveProposalRows([cand("Always run the tests.")]).rows[0]!;
        const b = deriveDirectiveProposalRows([cand("Always run the tests.")]).rows[0]!;
        expect(a.sig).toBe(b.sig);
        expect(a.sig).toBe(dedupeSig("guidance", normalizeTitle(a.title)));
    });

    test("minFrequency filters one-off directives; skipped counted", () => {
        const { rows, skipped } = deriveDirectiveProposalRows(
            [cand("Make sure you use absolute paths.")],
            { minFrequency: 2 },
        );
        expect(rows).toHaveLength(0);
        expect(skipped).toBe(1);
    });

    test("sorts by frequency desc and caps at the limit", () => {
        const candidates = [
            cand("Always wrap copy in code blocks."),
            cand("Always wrap copy in code blocks."),
            cand("Always wrap copy in code blocks."),
            cand("Remember to commit each part."),
        ];
        const { rows } = deriveDirectiveProposalRows(candidates, { limit: 1 });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.title).toContain("wrap copy");
        expect(rows[0]!.frequency).toBe(3);
    });
});

describe("deriveGuidanceProposalRows + buildGuidanceProposalStatements (Phase C11)", () => {
    const candidate: HarnessLearningCandidate = {
        title: "Block main-branch edits in multi-agent projects",
        problem: "Agents edited main directly.",
        pattern: "Escalate guidance to workflow.",
        harnessLayer: "boundary",
        risk: { kind: "branch_safety", level: "high" },
        appliesWhen: ["multi-agent work"],
        avoidWhen: ["hotfix approval"],
        evidenceSummary: ["current branch: main", "two recent commits from main"],
        suggestedIntervention: "Confirm branch before writes.",
        confidence: "medium",
    };

    test("converts harness candidate into a guidance_proposal row with dedupe_sig", () => {
        const { rows, skipped } = deriveGuidanceProposalRows([candidate]);
        expect(skipped).toBe(0);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.title).toBe(candidate.title);
        expect(row.hypothesis).toBe(candidate.problem);
        expect(row.sig.startsWith("guidance__")).toBe(true);
        expect(row.fileTarget).toBe("CLAUDE.md");
        expect(row.frequency).toBeGreaterThanOrEqual(2);
    });

    test("CREATE statement for new sig + UPSERT guidance_proposal payload", () => {
        const { rows } = deriveGuidanceProposalRows([candidate]);
        const sql = buildGuidanceProposalStatements(rows, new Set()).join("\n");
        expect(sql).toContain("CREATE proposal:");
        expect(sql).toContain("form: \"guidance\"");
        expect(sql).toContain("status: \"open\"");
        expect(sql).toContain("UPSERT guidance_proposal:");
        expect(sql).toContain("file_target: \"CLAUDE.md\"");
        expect(sql).toContain("section: \"boundary\"");
    });

    test("dedupes within one batch", () => {
        const { rows, skipped } = deriveGuidanceProposalRows([candidate, candidate]);
        expect(rows).toHaveLength(1);
        expect(skipped).toBe(1);
    });
});

describe("deriveRoutingProposalRow", () => {
    const baseInput = {
        candidateCount: 12,
        totalEstSavingsUsd: 25.50,
        sinceDays: 14,
        topClasses: [
            { classId: "search-locate", savings_usd: 18.00 },
            { classId: "research", savings_usd: 7.50 },
        ],
    } as const;

    test("returns null when candidateCount < 5 (signal too thin)", () => {
        expect(deriveRoutingProposalRow({ ...baseInput, candidateCount: 4 })).toBeNull();
    });

    test("returns null when totalEstSavingsUsd < 5 (savings too low)", () => {
        expect(deriveRoutingProposalRow({ ...baseInput, totalEstSavingsUsd: 4.99 })).toBeNull();
    });

    test("returns null when BOTH thresholds are below minimum", () => {
        expect(deriveRoutingProposalRow({ ...baseInput, candidateCount: 3, totalEstSavingsUsd: 2 })).toBeNull();
    });

    test("emits a row when both thresholds pass", () => {
        const row = deriveRoutingProposalRow(baseInput);
        expect(row).not.toBeNull();
        expect(row!.title).toBe("Route mechanical subagent dispatches to cheaper models");
        expect(row!.frequency).toBe(12);
        expect(row!.sig.startsWith("hook__")).toBe(true);
    });

    test("confidence=high when savings >= 50", () => {
        const row = deriveRoutingProposalRow({ ...baseInput, totalEstSavingsUsd: 60 });
        expect(row!.confidence).toBe("high");
    });

    test("confidence=medium when savings >= 15 and < 50", () => {
        const row = deriveRoutingProposalRow({ ...baseInput, totalEstSavingsUsd: 20 });
        expect(row!.confidence).toBe("medium");
    });

    test("confidence=low when savings < 15", () => {
        const row = deriveRoutingProposalRow({ ...baseInput, totalEstSavingsUsd: 8 });
        expect(row!.confidence).toBe("low");
    });

    test("hypothesis includes candidateCount, sinceDays, savings, and top class ids", () => {
        const row = deriveRoutingProposalRow(baseInput);
        expect(row!.hypothesis).toContain("12 model-less dispatches");
        expect(row!.hypothesis).toContain("last 14d");
        expect(row!.hypothesis).toContain("$25.50");
        expect(row!.hypothesis).toContain("search-locate");
        expect(row!.hypothesis).toContain("research");
    });

    test("dedupe_sig is STABLE across two derivations with different savings amounts", () => {
        const row1 = deriveRoutingProposalRow({ ...baseInput, totalEstSavingsUsd: 20, candidateCount: 10 });
        const row2 = deriveRoutingProposalRow({ ...baseInput, totalEstSavingsUsd: 80, candidateCount: 50 });
        // Savings differ (hypothesis differs) but title is identical → same dedupe_sig
        expect(row1!.sig).toBe(row2!.sig);
    });

    test("dedupe_sig is stable across two derivations with identical inputs", () => {
        const row1 = deriveRoutingProposalRow(baseInput);
        const row2 = deriveRoutingProposalRow(baseInput);
        expect(row1!.sig).toBe(row2!.sig);
    });
});

describe("buildRoutingProposalStatements", () => {
    const baseRoutingRow = deriveRoutingProposalRow({
        candidateCount: 12,
        totalEstSavingsUsd: 25.50,
        sinceDays: 14,
        topClasses: [{ classId: "search-locate", savings_usd: 18.00 }],
    })!;

    test("new sig: CREATE proposal with form='hook', baseline, status='open'", () => {
        const stmts = buildRoutingProposalStatements(baseRoutingRow, new Set());
        const sql = stmts.join("\n");
        expect(sql).toContain("CREATE proposal:");
        expect(sql).toContain("form: \"hook\"");
        expect(sql).toContain("status: \"open\"");
        expect(sql).toContain("baseline:");
        expect(sql).toContain(`frequency: ${baseRoutingRow.frequency}`);
    });

    test("existing sig: UPDATE mutable fields only, no baseline/status touch", () => {
        const stmts = buildRoutingProposalStatements(baseRoutingRow, new Set([baseRoutingRow.sig]));
        const sql = stmts.join("\n");
        expect(sql).toContain("UPDATE proposal:");
        expect(sql).not.toContain("CREATE proposal:");
        expect(sql).not.toMatch(/\bstatus\s*=/);
        expect(sql).not.toMatch(/\bbaseline\s*=/);
        expect(sql).toMatch(/\bfrequency\s*=\s*12/);
    });

    test("statement contains form hook and frequency", () => {
        const stmts = buildRoutingProposalStatements(baseRoutingRow, new Set());
        const sql = stmts.join("\n");
        expect(sql).toContain("form: \"hook\"");
        expect(sql).toContain(String(baseRoutingRow.frequency));
    });
});

// ---------------------------------------------------------------------------
// Image context proposal tests
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

const makeImageContextResult = (mainBytes: number, mainCalls: number): ImageContextResult => ({
    rows: [],
    totals: { mainBytes, mainCalls, subagentBytes: 0, subagentCalls: 0 },
});

describe("deriveImageContextProposalRow", () => {
    test("returns null when main bytes are below the threshold", () => {
        const result = makeImageContextResult((IMAGE_CONTEXT_THRESHOLD_MB - 1) * MB, 10);
        expect(deriveImageContextProposalRow(result, 14)).toBeNull();
    });

    test("returns null when main bytes are exactly zero", () => {
        expect(deriveImageContextProposalRow(makeImageContextResult(0, 0), 14)).toBeNull();
    });

    test("emits a row when main bytes meet the threshold", () => {
        const result = makeImageContextResult(IMAGE_CONTEXT_THRESHOLD_MB * MB, 5);
        const row = deriveImageContextProposalRow(result, 14);
        expect(row).not.toBeNull();
        expect(row!.title).toBe("Isolate large-image visual judgment to a subagent");
        expect(row!.frequency).toBe(5);
        expect(row!.sig.startsWith("subagent__")).toBe(true);
    });

    test("confidence=medium at threshold (20 MB)", () => {
        const row = deriveImageContextProposalRow(makeImageContextResult(IMAGE_CONTEXT_THRESHOLD_MB * MB, 3), 14);
        expect(row!.confidence).toBe("medium");
    });

    test("confidence=high when main bytes >= 50 MB", () => {
        const row = deriveImageContextProposalRow(makeImageContextResult(50 * MB, 20), 14);
        expect(row!.confidence).toBe("high");
    });

    test("hypothesis includes MB figure, sinceDays, and call count", () => {
        const row = deriveImageContextProposalRow(makeImageContextResult(30 * MB, 8), 14);
        expect(row!.hypothesis).toContain("30.0 MB");
        expect(row!.hypothesis).toContain("last 14d");
        expect(row!.hypothesis).toContain("8 image reads");
        expect(row!.hypothesis).toContain("ax cost images");
        expect(row!.hypothesis).toContain("isolate-heavy-context");
    });

    test("dedupe_sig is stable across two derivations with different byte counts", () => {
        const row1 = deriveImageContextProposalRow(makeImageContextResult(25 * MB, 5), 14);
        const row2 = deriveImageContextProposalRow(makeImageContextResult(60 * MB, 20), 14);
        // Byte counts differ (hypothesis differs) but title is identical -> same dedupe_sig
        expect(row1!.sig).toBe(row2!.sig);
    });
});

describe("buildImageContextProposalStatements", () => {
    const baseRow = deriveImageContextProposalRow(
        makeImageContextResult(25 * MB, 7),
        14,
    )!;

    test("new sig: CREATE proposal with form='subagent', baseline, status='open'", () => {
        const stmts = buildImageContextProposalStatements(baseRow, new Set());
        const sql = stmts.join("\n");
        expect(sql).toContain("CREATE proposal:");
        expect(sql).toContain("form: \"subagent\"");
        expect(sql).toContain("status: \"open\"");
        expect(sql).toContain("baseline:");
        expect(sql).toContain(`dedupe_sig: "${baseRow.sig}"`);
    });

    test("existing sig: UPDATE mutable fields only, no baseline/status touch", () => {
        const stmts = buildImageContextProposalStatements(baseRow, new Set([baseRow.sig]));
        const sql = stmts.join("\n");
        expect(sql).toContain("UPDATE proposal:");
        expect(sql).not.toContain("CREATE proposal:");
        expect(sql).not.toMatch(/\bstatus\s*=/);
        expect(sql).not.toMatch(/\bbaseline\s*=/);
        expect(sql).toMatch(/\bfrequency\s*=\s*7/);
    });
});

// ---------------------------------------------------------------------------
// Workflow proposal tests (B3)
// ---------------------------------------------------------------------------

describe("deriveWorkflowProposalRows", () => {
    test("maps arcs to guidance/workflows proposal rows with correct title/frequency/section/sig", () => {
        const { rows } = deriveWorkflowProposalRows([
            { steps: ["plan", "tdd", "review", "commit"], support: 5 },
            { steps: ["recall", "read", "edit", "test"], support: 3 },
        ], { minSessions: 3 });
        expect(rows).toHaveLength(2);
        expect(rows[0]!.title).toContain("Workflow:");
        expect(rows[0]!.title).toContain("plan");
        expect(rows[0]!.frequency).toBe(5); // support → frequency
        expect(rows[0]!.section).toBe("workflows"); // discriminator
        // stable sig: same arc → same sig
        const again = deriveWorkflowProposalRows([{ steps: ["plan", "tdd", "review", "commit"], support: 5 }]);
        expect(again.rows[0]!.sig).toBe(rows[0]!.sig);
    });

    test("skips arcs below minSessions and counts them in skipped", () => {
        const { rows, skipped } = deriveWorkflowProposalRows(
            [{ steps: ["a", "b", "c"], support: 2 }],
            { minSessions: 3 },
        );
        expect(rows).toHaveLength(0);
        expect(skipped).toBe(1);
    });

    test("defaults to minSessions=3 when not specified", () => {
        const { rows, skipped } = deriveWorkflowProposalRows([
            { steps: ["a", "b", "c"], support: 3 },
            { steps: ["x", "y", "z"], support: 2 },
        ]);
        expect(rows).toHaveLength(1);
        expect(skipped).toBe(1);
    });

    test("buildGuidanceProposalStatements emits section='workflows' in SQL for workflow rows", () => {
        const { rows } = deriveWorkflowProposalRows([
            { steps: ["plan", "tdd", "review"], support: 4 },
        ]);
        const sql = buildGuidanceProposalStatements(rows, new Set()).join("\n");
        expect(sql).toContain("section: \"workflows\"");
        expect(sql).toContain("form: \"guidance\"");
        expect(sql).toContain("UPSERT guidance_proposal:");
    });

    test("sig is stable across independent calls with same arc", () => {
        const a = deriveWorkflowProposalRows([{ steps: ["plan", "tdd", "commit"], support: 4 }]).rows[0]!;
        const b = deriveWorkflowProposalRows([{ steps: ["plan", "tdd", "commit"], support: 9 }]).rows[0]!;
        expect(a.sig).toBe(b.sig); // support changes don't affect sig
    });

    test("sorts rows by frequency desc (highest support first)", () => {
        const { rows } = deriveWorkflowProposalRows([
            { steps: ["a", "b", "c"], support: 3 },
            { steps: ["d", "e", "f", "g"], support: 7 },
        ]);
        expect(rows[0]!.frequency).toBe(7);
        expect(rows[1]!.frequency).toBe(3);
    });
});
