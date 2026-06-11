import { describe, expect, test } from "bun:test";
import {
    buildGuidanceProposalStatements,
    buildRoutingProposalStatements,
    buildSkillProposalStatements,
    dedupeSig,
    deriveGuidanceProposalRows,
    deriveRoutingProposalRow,
    deriveSkillProposalRows,
    normalizeTitle,
    parseMetrics,
    skillProposalFrequency,
} from "./derive-proposals.ts";
import type { HarnessLearningCandidate } from "../project/types.ts";

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
