import { describe, expect, test } from "bun:test";
import {
    buildGuidanceProposalStatements,
    buildSkillProposalStatements,
    dedupeSig,
    deriveGuidanceProposalRows,
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

    test("skillProposalFrequency picks the larger of fix_chain_count / risky_session_count", () => {
        expect(skillProposalFrequency({ fix_chain_count: 3, risky_session_count: 7 })).toBe(7);
        expect(skillProposalFrequency({ fix_chain_count: 9 })).toBe(9);
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
