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
): Effect.Effect<DeriveProposalsStats, DbError, SurrealClient> =>
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
        const { rows, skipped } = deriveSkillProposalRows(candidates, existingSkillNames, opts.minFrequency);
        const stmts = buildSkillProposalStatements(rows, existingSigs);

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
