import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { Judgment, JudgmentLayer } from "@ax/lib/sqlite";
import { stableId } from "@ax/lib/stable-id";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import {
    buildCacheLensProposalWrites,
    buildGuidanceProposalWrites,
    buildImageContextProposalWrites,
    buildRoutingProposalWrites,
    buildSkillProposalWrites,
    CACHE_LENS_PROPOSAL_CAP,
    cacheLensConfidence,
    dedupeSig,
    deriveCacheLensProposalRows,
    deriveDirectiveProposalRows,
    deriveGuidanceProposalRows,
    deriveImageContextProposalRow,
    deriveRoutingProposalRow,
    deriveSkillProposalRows,
    deriveWorkflowProposalRows,
    evaluateCacheLensCandidate,
    IMAGE_CONTEXT_THRESHOLD_MB,
    normalizeTitle,
    parseMetrics,
    migrateProposalDedupeSigs,
    skillProposalFrequency,
} from "./derive-proposals.ts";
import type { HarnessLearningCandidate } from "../project/types.ts";
import type { ImageContextResult } from "../queries/image-context.ts";
import type { CacheLensCandidateRow } from "../queries/cache-bust.ts";

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
        expect(a).toBe("skill__0efefbef285843e6");
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

describe("proposal dedupe signature migration", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    test("re-keys old signatures without losing decisions or sidecar links", async () => {
        const dir = mkdtempSync(join(tmpdir(), "ax-proposal-dedupe-"));
        dirs.push(dir);
        const sidecarPath = join(dir, "judgment.sqlite");

        const rows = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            const skillTitle = "Schema  Change Guardrail";
            const guidanceTitle = "Keep decisions durable";
            const oldSkillSig = `skill__${Bun.hash(`skill:${normalizeTitle(skillTitle)}`).toString(16).slice(0, 16)}`;
            const oldGuidanceSig = `guidance__${Bun.hash(`guidance:${normalizeTitle(guidanceTitle)}`).toString(16).slice(0, 16)}`;
            const oldSkillId = `skill__schema_change_guardrail__${oldSkillSig.slice(-12)}`;
            const oldGuidanceId = stableId("proposal", [oldGuidanceSig]);
            yield* judgment.put("proposal", {
                id: oldSkillId,
                form: "skill",
                title: skillTitle,
                hypothesis: "test",
                dedupe_sig: oldSkillSig,
                confidence: "high",
                status: "rejected",
                reject_reason: "user decision",
            });
            yield* judgment.put("skill_proposal", {
                id: oldSkillId,
                proposal: oldSkillId,
                trigger_pattern: "schema edit",
                suspected_gap: "no guard",
                proposed_behavior: "add guard",
            });
            yield* judgment.put("proposal", {
                id: oldGuidanceId,
                form: "guidance",
                title: guidanceTitle,
                hypothesis: "test",
                dedupe_sig: oldGuidanceSig,
                confidence: "medium",
                status: "accepted",
                origin: "agent",
                baseline: JSON.stringify({ origin: "agent" }),
            });
            yield* judgment.put("guidance_proposal", {
                id: stableId("guidance_proposal", [oldGuidanceId]),
                proposal: oldGuidanceId,
                file_target: "CLAUDE.md",
                suggested_text: "Keep decisions durable.",
            });
            yield* judgment.put("experiment", {
                id: "experiment-old",
                proposal: oldGuidanceId,
                status: "task_emitted",
            });

            yield* migrateProposalDedupeSigs(judgment);
            yield* migrateProposalDedupeSigs(judgment);

            return yield* judgment.rows(Schema.Struct({
                id: Schema.String,
                dedupe_sig: Schema.String,
                status: Schema.String,
                reject_reason: Schema.NullOr(Schema.String),
                payload_id: Schema.NullOr(Schema.String),
                payload_proposal: Schema.NullOr(Schema.String),
                experiment_proposal: Schema.NullOr(Schema.String),
            }), `
SELECT p.id, p.dedupe_sig, p.status, p.reject_reason,
       COALESCE(sp.id, gp.id) AS payload_id,
       COALESCE(sp.proposal, gp.proposal) AS payload_proposal,
       e.proposal AS experiment_proposal
FROM proposal p
LEFT JOIN skill_proposal sp ON sp.proposal = p.id
LEFT JOIN guidance_proposal gp ON gp.proposal = p.id
LEFT JOIN experiment e ON e.proposal = p.id
ORDER BY p.id`);
        }).pipe(
            Effect.scoped,
            Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })),
        ));

        const newSkillSig = dedupeSig("skill", normalizeTitle("Schema  Change Guardrail"));
        const newGuidanceSig = dedupeSig("guidance", normalizeTitle("Keep decisions durable"));
        const newSkillId = `skill__schema_change_guardrail__${newSkillSig.slice(-12)}`;
        const newGuidanceId = stableId("proposal", [newGuidanceSig]);
        expect(rows).toEqual([
            {
                id: newGuidanceId,
                dedupe_sig: newGuidanceSig,
                status: "accepted",
                reject_reason: null,
                payload_id: stableId("guidance_proposal", [newGuidanceId]),
                payload_proposal: newGuidanceId,
                experiment_proposal: newGuidanceId,
            },
            {
                id: newSkillId,
                dedupe_sig: newSkillSig,
                status: "rejected",
                reject_reason: "user decision",
                payload_id: newSkillId,
                payload_proposal: newSkillId,
                experiment_proposal: null,
            },
        ].sort((a, b) => a.id.localeCompare(b.id)));
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

describe("buildSkillProposalWrites", () => {
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
        const writes = buildSkillProposalWrites([baseRow], new Set());
        expect(writes.map((write) => write.table)).toEqual(["proposal", "skill_proposal", "cites_evidence"]);
        expect(writes[0]!.row).toMatchObject({ status: "open", dedupe_sig: baseRow.sig, form: "skill" });
        expect(writes[0]!.row.baseline).toBe(JSON.stringify({ frequency: 5, metrics: baseRow.metrics }));
    });

    test("existing sig: UPDATE refresh-able fields ONLY, no baseline/status touch", () => {
        const writes = buildSkillProposalWrites([baseRow], new Set([baseRow.sig]));
        expect(writes[0]!.row).toMatchObject({ frequency: 5, confidence: "high" });
        expect(writes[0]!.row).not.toHaveProperty("status");
        expect(writes[0]!.row).not.toHaveProperty("baseline");
        expect(writes[0]!.row).not.toHaveProperty("created_at");
        expect(writes[1]!.table).toBe("skill_proposal");
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
        const writes = buildGuidanceProposalWrites(rows, new Set());
        expect(writes.map((write) => write.table)).toEqual(["proposal", "guidance_proposal"]);
        expect(writes[0]!.row).toMatchObject({ form: "guidance", status: "open" });
        expect(writes[1]!.row).toMatchObject({ file_target: "CLAUDE.md", section: "boundary" });
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

describe("buildRoutingProposalWrites", () => {
    const baseRoutingRow = deriveRoutingProposalRow({
        candidateCount: 12,
        totalEstSavingsUsd: 25.50,
        sinceDays: 14,
        topClasses: [{ classId: "search-locate", savings_usd: 18.00 }],
    })!;

    test("new sig: CREATE proposal with form='hook', baseline, status='open'", () => {
        const writes = buildRoutingProposalWrites(baseRoutingRow, new Set());
        expect(writes[0]!.row).toMatchObject({ form: "hook", status: "open", frequency: baseRoutingRow.frequency });
        expect(writes[0]!.row.baseline).toBe(JSON.stringify({ frequency: baseRoutingRow.frequency }));
    });

    test("existing sig: UPDATE mutable fields only, no baseline/status touch", () => {
        const writes = buildRoutingProposalWrites(baseRoutingRow, new Set([baseRoutingRow.sig]));
        expect(writes[0]!.row.frequency).toBe(12);
        expect(writes[0]!.row).not.toHaveProperty("status");
        expect(writes[0]!.row).not.toHaveProperty("baseline");
    });

    test("statement contains form hook and frequency", () => {
        const writes = buildRoutingProposalWrites(baseRoutingRow, new Set());
        expect(writes[0]!.row).toMatchObject({ form: "hook", frequency: baseRoutingRow.frequency });
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

describe("buildImageContextProposalWrites", () => {
    const baseRow = deriveImageContextProposalRow(
        makeImageContextResult(25 * MB, 7),
        14,
    )!;

    test("new sig: CREATE proposal with form='subagent', baseline, status='open'", () => {
        const writes = buildImageContextProposalWrites(baseRow, new Set());
        expect(writes[0]!.row).toMatchObject({ form: "subagent", status: "open", dedupe_sig: baseRow.sig });
        expect(writes[0]!.row).toHaveProperty("baseline");
    });

    test("existing sig: UPDATE mutable fields only, no baseline/status touch", () => {
        const writes = buildImageContextProposalWrites(baseRow, new Set([baseRow.sig]));
        expect(writes[0]!.row.frequency).toBe(7);
        expect(writes[0]!.row).not.toHaveProperty("status");
        expect(writes[0]!.row).not.toHaveProperty("baseline");
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

    test("buildGuidanceProposalWrites emits workflow guidance rows", () => {
        const { rows } = deriveWorkflowProposalRows([
            { steps: ["plan", "tdd", "review"], support: 4 },
        ]);
        const writes = buildGuidanceProposalWrites(rows, new Set());
        expect(writes[0]!.row.form).toBe("guidance");
        expect(writes[1]).toMatchObject({ table: "guidance_proposal", row: { section: "workflows" } });
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

// ---------------------------------------------------------------------------
// Cache-lens proposal tests (slice B, #868)
// ---------------------------------------------------------------------------

const makeCacheLensCandidate = (
    o: Partial<CacheLensCandidateRow> = {},
): CacheLensCandidateRow => ({
    kind: "skill",
    name: "design-curator",
    busts: 20,
    sessions: 8,
    distinctDays: 5,
    bustCostUsd: 10, // 14d window -> $5/wk exactly at the threshold by default below
    comparableBusts: 20,
    comparableBustCostUsd: 10,
    comparableCorroboratedCostUsd: 10, // 0% delta
    reasonCounts: [{ reason: "tool_result_too_large", count: 15 }, { reason: "system_prompt_changed", count: 5 }],
    ...o,
});

describe("cacheLensConfidence", () => {
    test("<=10% delta is high, <=25% is medium, else low", () => {
        expect(cacheLensConfidence(0)).toBe("high");
        expect(cacheLensConfidence(0.10)).toBe("high");
        expect(cacheLensConfidence(0.11)).toBe("medium");
        expect(cacheLensConfidence(0.25)).toBe("medium");
        expect(cacheLensConfidence(0.26)).toBe("low");
    });
});

describe("evaluateCacheLensCandidate", () => {
    test("(a) passes all guards: mints with weekly cost + corroboration + dominant reason", () => {
        // 14d window, $10 total bust cost -> $5.00/wk, exactly at materiality.
        const candidate = makeCacheLensCandidate();
        const evaluation = evaluateCacheLensCandidate(candidate, 14);
        expect(evaluation).not.toBeNull();
        expect(evaluation!.weeklyCostUsd).toBeCloseTo(5, 5);
        expect(evaluation!.corroborationDeltaPct).toBe(0);
        expect(evaluation!.confidence).toBe("high");
        expect(evaluation!.dominantReason).toBe("tool_result_too_large");
        expect(evaluation!.dominantReasonPct).toBeCloseTo(0.75, 5);
    });

    test("(b) corroboration outside ±25% does not mint", () => {
        // comparable bust cost $10 vs corroborated $7 -> delta = 3/7 = ~42.9%
        const candidate = makeCacheLensCandidate({
            comparableBustCostUsd: 10,
            comparableCorroboratedCostUsd: 7,
        });
        expect(evaluateCacheLensCandidate(candidate, 14)).toBeNull();
    });

    test("corroboration exactly at ±25% still mints (boundary is inclusive)", () => {
        // delta = 2.5 / 10 = 25%
        const candidate = makeCacheLensCandidate({
            comparableBustCostUsd: 12.5,
            comparableCorroboratedCostUsd: 10,
            bustCostUsd: 12.5,
        });
        const evaluation = evaluateCacheLensCandidate(candidate, 14);
        expect(evaluation).not.toBeNull();
        expect(evaluation!.corroborationDeltaPct).toBeCloseTo(0.25, 5);
        expect(evaluation!.confidence).toBe("medium");
    });

    test("zero comparable busts never mints, regardless of other fields", () => {
        const candidate = makeCacheLensCandidate({ comparableBusts: 0, comparableBustCostUsd: 0, comparableCorroboratedCostUsd: 0 });
        expect(evaluateCacheLensCandidate(candidate, 14)).toBeNull();
    });

    test("(c) single-day recurrence does not mint", () => {
        const candidate = makeCacheLensCandidate({ distinctDays: 1 });
        expect(evaluateCacheLensCandidate(candidate, 14)).toBeNull();
    });

    test("(d) below $5/wk materiality does not mint", () => {
        // $10 total over a 90d window -> $0.78/wk, well under $5.
        const candidate = makeCacheLensCandidate({ distinctDays: 3, bustCostUsd: 10 });
        expect(evaluateCacheLensCandidate(candidate, 90)).toBeNull();
    });

    test("dominant reason picks the highest count and computes its share", () => {
        const candidate = makeCacheLensCandidate({
            reasonCounts: [
                { reason: "a", count: 1 },
                { reason: "b", count: 9 },
            ],
        });
        const evaluation = evaluateCacheLensCandidate(candidate, 14)!;
        expect(evaluation.dominantReason).toBe("b");
        expect(evaluation.dominantReasonPct).toBeCloseTo(0.9, 5);
    });
});

describe("deriveCacheLensProposalRows", () => {
    test("(a) mints exactly one proposal with title/hypothesis/baseline provenance", () => {
        const { rows, skipped } = deriveCacheLensProposalRows([makeCacheLensCandidate()], {
            sinceDays: 14,
            cap: CACHE_LENS_PROPOSAL_CAP,
            existingOpenSigs: new Set(),
        });
        expect(skipped).toBe(0);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.title).toBe("Trim cache-busting skill design-curator");
        expect(row.section).toBe("cache-lens");
        expect(row.fileTarget).toBe("CLAUDE.md");
        expect(row.confidence).toBe("high");
        expect(row.frequency).toBe(20); // busts
        expect(row.sig.startsWith("guidance__")).toBe(true);
        expect(row.hypothesis).toContain("design-curator");
        expect(row.hypothesis).toContain("$5.00/wk");
        expect(row.baseline).toMatchObject({
            origin: "cache-lens",
            offenderKind: "skill",
            offenderName: "design-curator",
            windowDays: 14,
            busts: 20,
            sessions: 8,
            confidence: "high",
        });
        expect(row.baseline.weeklyCostUsd).toBeCloseTo(5, 5);
        expect(row.baseline.corroborationDeltaPct).toBe(0);
        expect(row.baseline.reasonMix).toEqual(makeCacheLensCandidate().reasonCounts);
    });

    test("dedupe_sig is stable across independent derivations of the same offender", () => {
        const a = deriveCacheLensProposalRows([makeCacheLensCandidate()], {
            sinceDays: 14, cap: CACHE_LENS_PROPOSAL_CAP, existingOpenSigs: new Set(),
        }).rows[0]!;
        const b = deriveCacheLensProposalRows([makeCacheLensCandidate({ busts: 99, bustCostUsd: 40 })], {
            sinceDays: 14, cap: CACHE_LENS_PROPOSAL_CAP, existingOpenSigs: new Set(),
        }).rows[0]!;
        expect(a.sig).toBe(b.sig);
        expect(a.proposalKey).toBe(b.proposalKey);
    });

    test("(b)/(c)/(d) a candidate failing any guard is skipped, not minted", () => {
        const badCorroboration = makeCacheLensCandidate({ name: "bad-corr", comparableCorroboratedCostUsd: 1 });
        const badRecurrence = makeCacheLensCandidate({ name: "bad-days", distinctDays: 1 });
        const badMateriality = makeCacheLensCandidate({ name: "bad-cost", bustCostUsd: 0.5 });
        const { rows, skipped } = deriveCacheLensProposalRows(
            [badCorroboration, badRecurrence, badMateriality],
            { sinceDays: 14, cap: CACHE_LENS_PROPOSAL_CAP, existingOpenSigs: new Set() },
        );
        expect(rows).toHaveLength(0);
        expect(skipped).toBe(3);
    });

    test("(e) cap: 3 already-open cache-lens proposals -> a 4th (new) candidate is skipped", () => {
        const { rows, skipped } = deriveCacheLensProposalRows(
            [makeCacheLensCandidate({ name: "fourth-offender" })],
            {
                sinceDays: 14,
                cap: 3,
                existingOpenSigs: new Set(["guidance__existing1", "guidance__existing2", "guidance__existing3"]),
            },
        );
        expect(rows).toHaveLength(0);
        expect(skipped).toBe(1);
    });

    test("a candidate matching an ALREADY-OPEN sig refreshes for free (doesn't consume cap)", () => {
        const candidate = makeCacheLensCandidate();
        const { sig } = deriveCacheLensProposalRows([candidate], {
            sinceDays: 14, cap: CACHE_LENS_PROPOSAL_CAP, existingOpenSigs: new Set(),
        }).rows[0]!;
        // Cap is full (3 open), but ONE of those open sigs IS this candidate's sig -
        // its refresh must still happen even though capacityForNew is 0.
        const { rows, skipped } = deriveCacheLensProposalRows([candidate], {
            sinceDays: 14,
            cap: 3,
            existingOpenSigs: new Set(["guidance__other1", "guidance__other2", sig]),
        });
        expect(rows).toHaveLength(1);
        expect(skipped).toBe(0);
        expect(rows[0]!.sig).toBe(sig);
    });

    test("highest weekly-cost candidates mint first when several compete for remaining capacity", () => {
        // Both clear every guard ($5/wk and $25/wk, both >= the $5 materiality
        // floor, both 0%-delta corroboration) - the cap alone decides.
        const cheap = makeCacheLensCandidate({ name: "cheap", bustCostUsd: 10 }); // $5.00/wk
        const expensive = makeCacheLensCandidate({ name: "expensive", bustCostUsd: 50 }); // $25.00/wk
        const { rows, skipped } = deriveCacheLensProposalRows([cheap, expensive], {
            sinceDays: 14,
            cap: 1,
            existingOpenSigs: new Set(),
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.title).toContain("expensive");
        expect(skipped).toBe(1);
    });
});

describe("buildCacheLensProposalWrites", () => {
    const baseRow = deriveCacheLensProposalRows([makeCacheLensCandidate()], {
        sinceDays: 14, cap: CACHE_LENS_PROPOSAL_CAP, existingOpenSigs: new Set(),
    }).rows[0]!;

    test("new sig: CREATE proposal form='guidance' + guidance_proposal payload section='cache-lens'", () => {
        const writes = buildCacheLensProposalWrites([baseRow], new Set());
        expect(writes.map((w) => w.table)).toEqual(["proposal", "guidance_proposal"]);
        expect(writes[0]!.row).toMatchObject({ form: "guidance", status: "open", dedupe_sig: baseRow.sig });
        expect(writes[0]!.row.baseline).toBe(JSON.stringify(baseRow.baseline));
        expect(writes[1]!.row).toMatchObject({ file_target: "CLAUDE.md", section: "cache-lens" });
    });

    test("(f) existing sig: UPDATE mutable fields only - no baseline/status touch, no duplicate row shape", () => {
        const writes = buildCacheLensProposalWrites([baseRow], new Set([baseRow.sig]));
        expect(writes[0]!.row).toMatchObject({ frequency: baseRow.frequency, confidence: baseRow.confidence });
        expect(writes[0]!.row).not.toHaveProperty("status");
        expect(writes[0]!.row).not.toHaveProperty("baseline");
        expect(writes[0]!.row).not.toHaveProperty("created_at");
        // Re-deriving the SAME candidate twice produces the SAME dedupe_sig / proposalKey,
        // so the write-loop's `existingBySig` UPSERT (shared machinery, derive-proposals.ts)
        // targets the same row rather than inserting a duplicate - and, per that same loop,
        // a REJECTED existing row's `status`/`baseline` are preserved verbatim (never
        // resurrected to 'open'), which this UPDATE row deliberately omits both fields for.
        const again = buildCacheLensProposalWrites([baseRow], new Set([baseRow.sig]));
        expect(again[0]!.row.dedupe_sig).toBe(writes[0]!.row.dedupe_sig);
    });
});
