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
 * Baseline freezing: C1 writes the baseline JSON snapshot on every run.
 * This is acceptable for `status='open'` proposals because their experiment
 * row (Phase C3) will capture its OWN frozen baseline at accept-time from
 * the proposal's then-current snapshot. Refinement to skip baseline merge
 * on accepted proposals is deferred.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import {
    recordRef,
    surrealObject,
    surrealOptionString,
    surrealString,
} from "../lib/shared/surql.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { safeKeyPart, recordKeyPart } from "../lib/shared/derive-keys.ts";

export interface DeriveProposalsStats {
    readonly skillProposals: number;
    readonly skipped: number;
}

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

export const skillProposalFrequency = (
    metrics: Record<string, unknown>,
): number => {
    const fix = Number(metrics.fix_chain_count ?? 0);
    const risky = Number(metrics.risky_session_count ?? 0);
    return Math.max(Number.isFinite(fix) ? fix : 0, Number.isFinite(risky) ? risky : 0);
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

export const buildSkillProposalStatements = (rows: readonly SkillProposalRow[]): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("skill_proposal", row.proposalKey);
        const candidateRef = recordRef("skill_candidate", row.candidateKey);
        const edgeKey = `${row.proposalKey}__${row.candidateKey}`;
        const baseline = JSON.stringify({ frequency: row.frequency, metrics: row.metrics });

        stmts.push(
            `UPSERT ${proposalRef} MERGE ${surrealObject([
                ["form", surrealString("skill")],
                ["title", surrealString(row.title)],
                ["hypothesis", surrealString(row.hypothesis)],
                ["dedupe_sig", surrealString(row.sig)],
                ["frequency", String(row.frequency)],
                ["confidence", surrealString(row.confidence)],
                ["baseline", surrealOptionString(baseline)],
                ["updated_at", "time::now()"],
            ])};`,
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
): Effect.Effect<DeriveProposalsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [candidates, skills] = yield* Effect.all([
            db.query<[SkillCandidateRow[]]>(`
SELECT id, name, trigger_pattern, suspected_gap, proposed_behavior, confidence, expected_impact, metrics
FROM skill_candidate;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[SkillRow[]]>(`SELECT name FROM skill;`).pipe(Effect.map((rows) => rows?.[0] ?? [])),
        ], { concurrency: 2 });

        const existingSkillNames = new Set(skills.map((s) => normalizeTitle(s.name)));
        const { rows, skipped } = deriveSkillProposalRows(candidates, existingSkillNames, opts.minFrequency);
        const stmts = buildSkillProposalStatements(rows);

        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        return { skillProposals: rows.length, skipped };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveProposals().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveProposalsStats>,
    );
}
