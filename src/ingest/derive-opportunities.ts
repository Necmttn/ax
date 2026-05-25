/**
 * Derive-Opportunities Stage (Phase C5).
 *
 * Each active experiment (proposal.status='accepted', locked_verdict
 * IS NONE) collects `opportunity` rows for every new piece of trigger-
 * matching evidence after experiment.created_at. C6 then aggregates the
 * count + addressed ratio into a `checkpoint` row at t+7/t+30/t+90.
 *
 * C5 scope (skill form only - the only form that derives proposals today):
 *  - Trigger source: `later_fixed_by` edges (closure stage's fix-chain
 *    output). The MVP detector matches by category: a fix-chain is an
 *    opportunity for an experiment if the closure-derived candidate name
 *    that produced the proposal's skill_candidate would also match this
 *    fix-chain. For C5, we use a stricter shortcut - match any
 *    later_fixed_by with overlap_files JSON containing one of the
 *    candidate's path tokens.
 *  - was_addressed: always false for C5. Phase C5a wires the detector
 *    that resolves experiment.artifact_path -> skill row + checks
 *    `invoked` edges around matched_at.
 *
 * The opportunity row is a RELATION (in=experiment, out=evidence record).
 * Edge id = sha-style key over (experimentKey, evidenceKey) so re-derive
 * passes are idempotent.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef, surrealDate } from "../lib/shared/surql.ts";
import { surrealLiteral } from "../lib/json.ts";
import { executeStatementsWith } from "../lib/shared/statement-exec.ts";
import { safeKeyPart, recordKeyPart } from "../lib/shared/derive-keys.ts";

export interface DeriveOpportunitiesStats {
    readonly experimentsScanned: number;
    readonly opportunities: number;
}

interface ActiveExperimentRow {
    readonly id: string | { tb: string; id: string };
    readonly created_at: string;
    readonly form: string;
    readonly candidate_id: string | { tb: string; id: string } | null;
}

interface LaterFixedByRow {
    readonly id: string | { tb: string; id: string };
    readonly ts: string;
    readonly overlap_files: string | null;
}

export const opportunityKey = (experimentKey: string, evidenceKey: string): string =>
    `${safeKeyPart(experimentKey).slice(0, 48)}__${safeKeyPart(evidenceKey).slice(0, 48)}__${Bun.hash(`${experimentKey}:${evidenceKey}`).toString(16).slice(0, 12)}`;

export const parseOverlapFiles = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    } catch {
        return [];
    }
};

export const triggerTokensFromCandidate = (candidateKey: string): string[] => {
    // closure.ts derives candidate names like "SurrealDB_schema_change_guardrail";
    // tokens used for path matching are the lowercased word-segments.
    return candidateKey
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((tok) => tok.length >= 4 && tok !== "guardrail" && tok !== "checklist");
};

export const overlapFilesMatch = (
    files: readonly string[],
    tokens: readonly string[],
): boolean => {
    if (tokens.length === 0) return false;
    for (const file of files) {
        const lower = file.toLowerCase();
        for (const tok of tokens) {
            if (lower.includes(tok)) return true;
        }
    }
    return false;
};

export const buildOpportunityStatements = (
    experimentKey: string,
    matches: ReadonlyArray<{ readonly evidenceTable: string; readonly evidenceKey: string; readonly ts: string }>,
): string[] => {
    const stmts: string[] = [];
    for (const m of matches) {
        const edgeKey = opportunityKey(experimentKey, m.evidenceKey);
        const expRef = recordRef("experiment", experimentKey);
        const evRef = recordRef(m.evidenceTable, m.evidenceKey);
        stmts.push(
            `DELETE ${recordRef("opportunity", edgeKey)};`,
            `RELATE ${expRef}->opportunity:\`${edgeKey}\`->${evRef} SET matched_at = ${surrealDate(m.ts)}, was_addressed = false;`,
        );
    }
    return stmts;
};

export const deriveOpportunities = (): Effect.Effect<DeriveOpportunitiesStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Active = accepted proposal + experiment without a locked verdict.
        // Pull the skill_candidate id along the proposal -> cites_evidence
        // -> skill_candidate chain so we can derive trigger tokens.
        const experimentsResult = yield* db.query<[ActiveExperimentRow[]]>(`
            SELECT
                id,
                type::string(created_at) AS created_at,
                proposal.form AS form,
                (SELECT out FROM cites_evidence WHERE in = $parent.proposal LIMIT 1)[0].out AS candidate_id
            FROM experiment
            WHERE proposal.status = 'accepted'
              AND locked_verdict IS NONE
              AND proposal.form = 'skill';
        `);
        const experiments = experimentsResult?.[0] ?? [];

        let totalOpportunities = 0;
        const allStatements: string[] = [];
        for (const exp of experiments) {
            const experimentKey = recordKeyPart(exp.id, "experiment");
            if (!experimentKey) continue;
            const candidateKey = exp.candidate_id ? recordKeyPart(exp.candidate_id, "skill_candidate") : null;
            if (!candidateKey) continue;
            const tokens = triggerTokensFromCandidate(candidateKey);
            if (tokens.length === 0) continue;

            const sinceLiteral = surrealLiteral(exp.created_at);
            const fixesResult = yield* db.query<[LaterFixedByRow[]]>(`
                SELECT id, type::string(ts) AS ts, overlap_files
                FROM later_fixed_by
                WHERE ts > d${sinceLiteral};
            `);
            const fixes = fixesResult?.[0] ?? [];
            const matches: Array<{ evidenceTable: string; evidenceKey: string; ts: string }> = [];
            for (const fix of fixes) {
                const files = parseOverlapFiles(fix.overlap_files);
                if (!overlapFilesMatch(files, tokens)) continue;
                const evidenceKey = recordKeyPart(fix.id, "later_fixed_by");
                if (!evidenceKey) continue;
                matches.push({ evidenceTable: "later_fixed_by", evidenceKey, ts: fix.ts });
            }
            totalOpportunities += matches.length;
            allStatements.push(...buildOpportunityStatements(experimentKey, matches));
        }

        yield* executeStatementsWith(db, allStatements, { chunkSize: 500 });
        return { experimentsScanned: experiments.length, opportunities: totalOpportunities };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveOpportunities().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveOpportunitiesStats>,
    );
}
