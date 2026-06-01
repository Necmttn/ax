/**
 * Derive-Proposals Stage: turns evidence rows into proposal shortlist rows.
 *
 * Reads skill_candidate (populated by the closure stage) + the skill catalog
 * (to dedupe against existing skills) and writes:
 *   - proposal              (polymorphic shortlist, form=skill)
 *   - skill_proposal        (typed form payload)
 *   - cites_evidence edges  (proposal -> source skill_candidate)
 *
 * C1 scope: skill form only. subagent/hook/guidance/automation forms land
 * in later C1.x commits as their evidence detectors come online.
 *
 * Dedupe: dedupe_sig = hash(form + normalized title) - UNIQUE index on
 * proposal.dedupe_sig prevents the same trigger pattern producing two
 * proposals across re-derive runs.
 *
 * Baseline freezing (post-review fix): the proposal's `baseline` JSON is
 * captured ONLY on first creation. Subsequent re-derive runs UPDATE the
 * mutable fields (frequency, confidence, hypothesis, updated_at) but never
 * touch `baseline` or `status`. This honors the plan's "frozen at
 * created_at, not accept-time" decision so the verdict layer (C6) can
 * compute friction_delta against a stable reference point.
 */

import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import {
    recordRef,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { safeKeyPart, recordKeyPart } from "@ax/lib/shared/derive-keys";
import type { HarnessLearningCandidate } from "../project/types.ts";

export interface DeriveProposalsStats {
    readonly skillProposals: number;
    readonly guidanceProposals: number;
    readonly skipped: number;
}

/**
 * Phase C11: convert each HarnessLearningCandidate into a guidance-form
 * proposal. The harness report's learning candidates are the
 * project-doctor-derived "you should add a guardrail" suggestions. They flow
 * into the proposal pipeline as form='guidance', deduped by hash of normalized
 * title.
 */
export interface GuidanceProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly fileTarget: string;
    readonly section: string;
    readonly suggestedText: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly evidenceSummary: ReadonlyArray<string>;
}

export const deriveGuidanceProposalRows = (
    candidates: ReadonlyArray<HarnessLearningCandidate>,
): { readonly rows: GuidanceProposalRow[]; readonly skipped: number } => {
    const rows: GuidanceProposalRow[] = [];
    let skipped = 0;
    const seenSigs = new Set<string>();
    for (const c of candidates) {
        if (!c.title || !c.problem) { skipped += 1; continue; }
        const normTitle = normalizeTitle(c.title);
        const sig = dedupeSig("guidance", normTitle);
        if (seenSigs.has(sig)) { skipped += 1; continue; }
        seenSigs.add(sig);
        // Frequency proxy: evidence-summary count + risk-level boost.
        // (Harness-derived candidates don't have a real recurrence count
        // - they're snapshot signals - so we synthesize one.)
        const riskBoost = c.risk.level === "high" ? 3 : c.risk.level === "medium" ? 2 : 1;
        const frequency = Math.max(1, c.evidenceSummary.length) + riskBoost;
        rows.push({
            proposalKey: proposalKeyFor("guidance", c.title, sig),
            title: c.title,
            hypothesis: c.problem,
            fileTarget: defaultGuidanceTargetFor(c.harnessLayer),
            section: c.harnessLayer,
            suggestedText: c.suggestedIntervention || c.pattern,
            confidence: c.confidence,
            frequency,
            sig,
            evidenceSummary: c.evidenceSummary,
        });
    }
    return { rows, skipped };
};

const defaultGuidanceTargetFor = (layer: string): string => {
    // Project-level harness candidates land in AGENTS.md / CLAUDE.md.
    // The user can move them; this is just a hint for the scaffold.
    if (layer === "boundary" || layer === "verification") return "CLAUDE.md";
    return "AGENTS.md";
};

export const buildGuidanceProposalStatements = (
    rows: readonly GuidanceProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("guidance_proposal", row.proposalKey);
        const baseline = JSON.stringify({
            frequency: row.frequency,
            evidence: row.evidenceSummary,
        });
        const isNew = !existingSigs.has(row.sig);

        if (isNew) {
            stmts.push(
                `CREATE ${proposalRef} CONTENT ${surrealObject([
                    ["form", surrealString("guidance")],
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["dedupe_sig", surrealString(row.sig)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["status", surrealString("open")],
                    ["baseline", surrealOptionString(baseline)],
                    ["updated_at", "time::now()"],
                ])};`,
            );
        } else {
            stmts.push(
                `UPDATE ${proposalRef} SET ${[
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["updated_at", "time::now()"],
                ].map(([n, v]) => `${n} = ${v}`).join(", ")};`,
            );
        }

        stmts.push(
            `UPSERT ${payloadRef} MERGE ${surrealObject([
                ["proposal", proposalRef],
                ["file_target", surrealString(row.fileTarget)],
                ["section", surrealOptionString(row.section)],
                ["suggested_text", surrealString(row.suggestedText)],
            ])};`,
        );
    }
    return stmts;
};

export interface DeriveProposalsOpts {
    readonly minFrequency: number;
}

interface SkillCandidateRow {
    readonly id: string | { tb: string; id: string };
    readonly name: string;
    readonly trigger_pattern: string;
    readonly suspected_gap: string;
    readonly proposed_behavior: string;
    readonly confidence: string;
    readonly expected_impact?: string | null;
    readonly metrics?: Record<string, unknown> | string | null;
}

interface SkillRow {
    readonly name: string;
}

export const normalizeTitle = (raw: string): string =>
    raw.toLowerCase().trim().replaceAll(/\s+/g, " ");

export const dedupeSig = (form: string, normalizedTitle: string): string =>
    `${form}__${Bun.hash(`${form}:${normalizedTitle}`).toString(16).slice(0, 16)}`;

export const parseMetrics = (
    raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> => {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
    }
    return raw;
};

/**
 * Frequency = `fix_chain_count` only. The legacy code also folded in
 * `risky_session_count` (any session with ≥5 errors / any correction / high
 * pressure) which matched every active dev and produced a top proposal
 * with freq=1072 - pure noise. The closure stage no longer emits that
 * metric; defensive: still read it but never trust it for ranking.
 */
export const skillProposalFrequency = (
    metrics: Record<string, unknown>,
): number => {
    const fix = Number(metrics.fix_chain_count ?? 0);
    return Number.isFinite(fix) ? fix : 0;
};

const proposalKeyFor = (form: string, title: string, sig: string): string =>
    `${form}__${safeKeyPart(title).slice(0, 60)}__${sig.slice(-12)}`;

export interface SkillProposalRow {
    readonly proposalKey: string;
    readonly candidateKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly triggerPattern: string;
    readonly suspectedGap: string;
    readonly proposedBehavior: string;
    readonly expectedImpact: string | null;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly metrics: Record<string, unknown>;
}

export const deriveSkillProposalRows = (
    candidates: readonly SkillCandidateRow[],
    existingSkillNames: ReadonlySet<string>,
    minFrequency: number,
): { readonly rows: SkillProposalRow[]; readonly skipped: number } => {
    const rows: SkillProposalRow[] = [];
    let skipped = 0;

    for (const candidate of candidates) {
        const metrics = parseMetrics(candidate.metrics);
        const frequency = skillProposalFrequency(metrics);
        if (frequency < minFrequency) { skipped += 1; continue; }

        const normTitle = normalizeTitle(candidate.name);
        if (existingSkillNames.has(normTitle)) { skipped += 1; continue; }

        const sig = dedupeSig("skill", normTitle);
        const candidateKey = recordKeyPart(candidate.id, "skill_candidate");
        if (candidateKey === null) { skipped += 1; continue; }
        rows.push({
            proposalKey: proposalKeyFor("skill", candidate.name, sig),
            candidateKey,
            title: candidate.name,
            hypothesis: candidate.suspected_gap,
            triggerPattern: candidate.trigger_pattern,
            suspectedGap: candidate.suspected_gap,
            proposedBehavior: candidate.proposed_behavior,
            expectedImpact: candidate.expected_impact ?? null,
            confidence: candidate.confidence,
            frequency,
            sig,
            metrics,
        });
    }

    return { rows, skipped };
};

/**
 * Build the SurrealQL statements for a batch of derived rows. The proposal
 * row is partitioned by whether its dedupe_sig already exists in the DB:
 *  - new sig  : insert a fresh proposal row (baseline captured here).
 *  - existing : refresh the mutable fields; baseline and status untouched.
 *
 * `existingSigs` is the set of dedupe_sig values currently in the proposal
 * table. The caller (`deriveProposals`) fetches it once before computing
 * rows so the partition is consistent within one ingest pass.
 */
export const buildSkillProposalStatements = (
    rows: readonly SkillProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("skill_proposal", row.proposalKey);
        const candidateRef = recordRef("skill_candidate", row.candidateKey);
        const edgeKey = `${row.proposalKey}__${row.candidateKey}`;
        const baseline = JSON.stringify({ frequency: row.frequency, metrics: row.metrics });
        const isNew = !existingSigs.has(row.sig);

        if (isNew) {
            stmts.push(
                `CREATE ${proposalRef} CONTENT ${surrealObject([
                    ["form", surrealString("skill")],
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["dedupe_sig", surrealString(row.sig)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["status", surrealString("open")],
                    ["baseline", surrealOptionString(baseline)],
                    ["updated_at", "time::now()"],
                ])};`,
            );
        } else {
            // Refresh mutable fields. Intentionally omits status + baseline.
            stmts.push(
                `UPDATE ${proposalRef} SET ${[
                    ["title", surrealString(row.title)],
                    ["hypothesis", surrealString(row.hypothesis)],
                    ["frequency", String(row.frequency)],
                    ["confidence", surrealString(row.confidence)],
                    ["updated_at", "time::now()"],
                ].map(([name, value]) => `${name} = ${value}`).join(", ")};`,
            );
        }

        stmts.push(
            `UPSERT ${payloadRef} MERGE ${surrealObject([
                ["proposal", proposalRef],
                ["trigger_pattern", surrealString(row.triggerPattern)],
                ["suspected_gap", surrealString(row.suspectedGap)],
                ["proposed_behavior", surrealString(row.proposedBehavior)],
                ["expected_impact", surrealOptionString(row.expectedImpact)],
            ])};`,
            `DELETE ${recordRef("cites_evidence", edgeKey)};`,
            `RELATE ${proposalRef}->cites_evidence:\`${edgeKey}\`->${candidateRef} SET count = ${String(Number(row.metrics.fix_chain_count ?? row.frequency))}, ts = time::now();`,
        );
    }
    return stmts;
};

export const deriveProposals = (
    opts: DeriveProposalsOpts = { minFrequency: 3 },
): Effect.Effect<DeriveProposalsStats, DbError, SurrealClient | import("@ax/lib/process").ProcessService> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [candidates, skills, existingProposals] = yield* Effect.all([
            db.query<[SkillCandidateRow[]]>(`
SELECT id, name, trigger_pattern, suspected_gap, proposed_behavior, confidence, expected_impact, metrics
FROM skill_candidate;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[SkillRow[]]>(`SELECT name FROM skill;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[Array<{ dedupe_sig: string }>]>(`SELECT dedupe_sig FROM proposal;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 3 });

        const existingSkillNames = new Set(skills.map((s) => normalizeTitle(s.name)));
        const existingSigs = new Set(existingProposals.map((p) => p.dedupe_sig));
        const { rows: skillRows, skipped: skillSkipped } =
            deriveSkillProposalRows(candidates, existingSkillNames, opts.minFrequency);
        const skillStmts = buildSkillProposalStatements(skillRows, existingSigs);

        // Phase C11: also derive guidance-form proposals from the harness
        // report. buildProjectHarnessReport is project-doctor logic that
        // identifies "you should add a guardrail" candidates; route those
        // into the proposal pipeline as guidance-form proposals.
        const { buildProjectHarnessReport } = yield* Effect.promise(() =>
            import("../project/harness.ts"),
        );
        const harnessReport = yield* buildProjectHarnessReport();
        const { rows: guidanceRows, skipped: guidanceSkipped } =
            deriveGuidanceProposalRows(harnessReport.learningCandidates);
        const guidanceStmts = buildGuidanceProposalStatements(guidanceRows, existingSigs);

        yield* executeStatementsWith(db, [...skillStmts, ...guidanceStmts], { chunkSize: 500 });
        return {
            skillProposals: skillRows.length,
            guidanceProposals: guidanceRows.length,
            skipped: skillSkipped + guidanceSkipped,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveProposals().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveProposalsStats>,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import type { ProcessService } from "@ax/lib/process";

export const ProposalsKey = Schema.Literal("proposals");
export type ProposalsKey = typeof ProposalsKey.Type;

/**
 * Proposals stage - derives Skill + Guidance Proposals from cumulated evidence.
 * Depends on {@link ClosureKey}. Consumed by {@link OpportunitiesKey}, {@link RetroProposalsKey}.
 */
export class ProposalsStats extends BaseStageStats.extend<ProposalsStats>("ProposalsStats")({
    skillProposals: Schema.Number,
    guidanceProposals: Schema.Number,
}) {}

export const proposalsStage: StageDef<ProposalsStats, SurrealClient | ProcessService> = {
    meta: StageMeta.make({ key: "proposals", deps: ["closure"], tags: ["derive"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveProposals({ minFrequency: 3 });
            return ProposalsStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.skillProposals} skill proposals, ${result.guidanceProposals} guidance proposals`,
                skillProposals: result.skillProposals,
                guidanceProposals: result.guidanceProposals,
            });
        }),
};
