/**
 * Derive-Retro-Proposals Stage: cluster repeating tool-failure signals
 * across `retro` rows and emit `skill`-form proposals.
 *
 * The retro emitter (src/ingest/retro.ts) writes one row per session whose
 * `failed` field contains strings like "Bash failed ×3 · friction kinds:
 * tool_error". This stage parses the `<Tool> failed ×<N>` substring,
 * clusters by (lowercased tool name) across the last N days, and emits a
 * `Pre-<Tool> guard` skill proposal when a tool recurs across ≥2 sessions
 * and ≥2 retros with a total count ≥3.
 *
 * Wedge scope: ONLY the "<Tool> failed ×<N>" shape. Other shapes
 * (corrections, friction kinds, free-text failures) are deliberately
 * out-of-scope for this commit - they'd require their own detectors.
 *
 * Why a separate stage from derive-proposals.ts? The proposals stage
 * reads `skill_candidate` (closure-stage output keyed on fix-chain
 * overlap). Retro-derived candidates come from a different evidence
 * source (per-session friction summaries) and have no fix-chain to cite,
 * so they bypass `skill_candidate` and write directly to `proposal` +
 * `skill_proposal`. The cluster -> proposal map is captured in
 * `proposal.baseline` JSON (tool + retroKeys + sessionKeys) since
 * `cites_evidence` doesn't yet support `retro` in its TO union.
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
import { dedupeSig, normalizeTitle } from "./derive-proposals.ts";

export interface DeriveRetroProposalsStats {
    readonly proposals: number;
    readonly skipped: number;
    readonly clusters: number;
}

/** A single failure mention parsed out of `retro.failed`. */
export interface ParsedToolFailure {
    readonly tool: string;
    readonly count: number;
}

/**
 * Extract every `<Tool> failed ×<N>` substring from a `retro.failed` value.
 *
 * The pattern is anchored on word boundaries and uses an alphanumeric/
 * underscore/hyphen tool-name shape to match the strings the heuristic
 * retro emitter produces (e.g. "Bash failed ×3", "Read failed ×2").
 * Free-text `failed` values that don't include this exact substring
 * yield an empty array - they're out-of-scope for this wedge.
 */
const TOOL_FAILED_RE =
    /\b([A-Za-z_][A-Za-z0-9_-]*)\s+failed\s+×(\d+)\b/g;

export const parseRetroFailed = (
    failed: string | null,
): Array<ParsedToolFailure> => {
    if (failed === null || failed === undefined) return [];
    const out: ParsedToolFailure[] = [];
    // Clone the regex each call - global regex state on a module-level
    // RegExp would leak across calls.
    const re = new RegExp(TOOL_FAILED_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(failed)) !== null) {
        const tool = m[1] ?? "";
        const count = Number(m[2] ?? 0);
        if (tool.length === 0 || !Number.isFinite(count) || count <= 0) continue;
        out.push({ tool, count });
    }
    return out;
};

export interface RetroFailureRow {
    readonly retroKey: string;
    readonly sessionKey: string;
    readonly failed: string | null;
}

export interface RetroCluster {
    readonly tool: string;
    readonly toolLower: string;
    readonly totalCount: number;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

interface MutableCluster {
    tool: string;
    toolLower: string;
    totalCount: number;
    retroKeys: Set<string>;
    sessionKeys: Set<string>;
}

export interface ClusterRetroToolFailuresOpts {
    readonly minSessions: number;
    readonly minRetros: number;
    readonly minTotalCount: number;
}

/**
 * Group parsed failures across retros by (lowercased tool name).
 *
 * The cased name preserved on the cluster is the FIRST one seen - so
 * a mix of "Bash" and "bash" mentions both land in one cluster and
 * the rendered proposal title uses whichever variant arrived first
 * (deterministic given input order).
 *
 * Clusters are sorted by descending totalCount so the caller can take
 * the head N if it wants to cap output.
 */
export const clusterRetroToolFailures = (
    rows: readonly RetroFailureRow[],
    opts: ClusterRetroToolFailuresOpts,
): RetroCluster[] => {
    const byTool = new Map<string, MutableCluster>();
    for (const row of rows) {
        const mentions = parseRetroFailed(row.failed);
        for (const mention of mentions) {
            const toolLower = mention.tool.toLowerCase();
            let cluster = byTool.get(toolLower);
            if (!cluster) {
                cluster = {
                    tool: mention.tool,
                    toolLower,
                    totalCount: 0,
                    retroKeys: new Set<string>(),
                    sessionKeys: new Set<string>(),
                };
                byTool.set(toolLower, cluster);
            }
            cluster.totalCount += mention.count;
            cluster.retroKeys.add(row.retroKey);
            cluster.sessionKeys.add(row.sessionKey);
        }
    }
    const out: RetroCluster[] = [];
    for (const cluster of byTool.values()) {
        if (cluster.sessionKeys.size < opts.minSessions) continue;
        if (cluster.retroKeys.size < opts.minRetros) continue;
        if (cluster.totalCount < opts.minTotalCount) continue;
        out.push({
            tool: cluster.tool,
            toolLower: cluster.toolLower,
            totalCount: cluster.totalCount,
            retroKeys: [...cluster.retroKeys],
            sessionKeys: [...cluster.sessionKeys],
        });
    }
    out.sort((a, b) => b.totalCount - a.totalCount);
    return out;
};

export interface RetroSkillProposalRow {
    readonly proposalKey: string;
    readonly title: string;
    readonly hypothesis: string;
    readonly triggerPattern: string;
    readonly suspectedGap: string;
    readonly proposedBehavior: string;
    readonly expectedImpact: string | null;
    readonly confidence: string;
    readonly frequency: number;
    readonly sig: string;
    readonly tool: string;
    readonly retroKeys: readonly string[];
    readonly sessionKeys: readonly string[];
}

const confidenceFor = (totalCount: number): string =>
    totalCount >= 10 ? "high" : totalCount >= 5 ? "medium" : "low";

const proposalKeyFor = (tool: string, sig: string): string =>
    `skill__retro__${safeKeyPart(tool).slice(0, 40)}__${sig.slice(-12)}`;

/**
 * Turn each cluster into a proposal row. A cluster whose normalized
 * title collides with an existing skill is skipped - we'd rather
 * surface "you have a guard already; it isn't firing" via the verdict
 * pipeline than emit a confusing duplicate.
 */
export const deriveRetroProposalRows = (
    clusters: readonly RetroCluster[],
    existingSkillNames: ReadonlySet<string>,
): { readonly rows: RetroSkillProposalRow[]; readonly skipped: number } => {
    const rows: RetroSkillProposalRow[] = [];
    let skipped = 0;
    for (const cluster of clusters) {
        const title = `Pre-${cluster.tool} guard`;
        const normTitle = normalizeTitle(title);
        if (existingSkillNames.has(normTitle)) { skipped += 1; continue; }
        const sig = dedupeSig("skill", normTitle);
        rows.push({
            proposalKey: proposalKeyFor(cluster.tool, sig),
            title,
            hypothesis: `${cluster.tool} failed ${cluster.totalCount} time(s) across ${cluster.sessionKeys.length} sessions; guard the call before invoking.`,
            triggerPattern: `tool=${cluster.tool}`,
            suspectedGap: `repeated ${cluster.tool} failures without a pre-call validation`,
            proposedBehavior: `validate ${cluster.tool} preconditions before invocation; on miss, surface a corrective message`,
            expectedImpact: `reduce ${cluster.tool} failure rate`,
            confidence: confidenceFor(cluster.totalCount),
            frequency: cluster.totalCount,
            sig,
            tool: cluster.tool,
            retroKeys: cluster.retroKeys,
            sessionKeys: cluster.sessionKeys,
        });
    }
    return { rows, skipped };
};

/**
 * Build the SurrealQL statements for a batch of derived rows.
 *
 * Mirrors {@link buildSkillProposalStatements} in derive-proposals.ts:
 * a fresh dedupe_sig becomes a `CREATE proposal` with frozen baseline +
 * status='open'; an existing sig becomes a minimal `UPDATE` of mutable
 * fields only. The `skill_proposal` payload is UPSERT-ed in both paths.
 *
 * Unlike the skill_candidate-sourced version, this writer does NOT emit
 * `cites_evidence` edges - the `retro` table isn't in the
 * `cites_evidence TO` union yet. Provenance is captured in the
 * `baseline` JSON instead (`tool`, `retroKeys`, `sessionKeys`).
 */
export const buildRetroSkillProposalStatements = (
    rows: readonly RetroSkillProposalRow[],
    existingSigs: ReadonlySet<string> = new Set(),
): string[] => {
    const stmts: string[] = [];
    for (const row of rows) {
        const proposalRef = recordRef("proposal", row.proposalKey);
        const payloadRef = recordRef("skill_proposal", row.proposalKey);
        const baseline = JSON.stringify({
            tool: row.tool,
            frequency: row.frequency,
            retroKeys: row.retroKeys,
            sessionKeys: row.sessionKeys,
        });
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
        );
    }
    return stmts;
};

export interface DeriveRetroProposalsOpts {
    readonly sinceDays?: number;
    readonly minSessions?: number;
    readonly minRetros?: number;
    readonly minTotalCount?: number;
}

interface RetroFetchRow {
    readonly id: string | { tb: string; id: string };
    readonly session: string | { tb: string; id: string } | null;
    readonly failed: string | null;
}

interface SkillNameRow {
    readonly name: string;
}

interface ProposalSigRow {
    readonly dedupe_sig: string;
}

export const deriveRetroProposals = (
    opts: DeriveRetroProposalsOpts = {},
): Effect.Effect<DeriveRetroProposalsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const sinceDays = opts.sinceDays ?? 30;
        const minSessions = opts.minSessions ?? 2;
        const minRetros = opts.minRetros ?? 2;
        const minTotalCount = opts.minTotalCount ?? 3;
        const db = yield* SurrealClient;

        const [retros, skills, existingProposals] = yield* Effect.all([
            db.query<[RetroFetchRow[]]>(
                `SELECT id, session, failed FROM retro WHERE failed != NONE AND created_at > time::now() - ${sinceDays}d;`,
            ).pipe(Effect.map((rows) => rows?.[0] ?? [])),
            db.query<[SkillNameRow[]]>(`SELECT name FROM skill;`).pipe(
                Effect.map((rows) => rows?.[0] ?? []),
            ),
            db.query<[ProposalSigRow[]]>(`SELECT dedupe_sig FROM proposal;`).pipe(
                Effect.map((rows) => rows?.[0] ?? []),
            ),
        ], { concurrency: 3 });

        const failureRows: RetroFailureRow[] = [];
        for (const r of retros) {
            const retroKey = recordKeyPart(r.id, "retro");
            const sessionKey = r.session ? recordKeyPart(r.session, "session") : null;
            if (!retroKey || !sessionKey) continue;
            failureRows.push({ retroKey, sessionKey, failed: r.failed });
        }

        const clusters = clusterRetroToolFailures(failureRows, {
            minSessions,
            minRetros,
            minTotalCount,
        });
        const existingSkillNames = new Set(
            skills.map((s) => normalizeTitle(s.name)),
        );
        const existingSigs = new Set(
            existingProposals.map((p) => p.dedupe_sig),
        );
        const { rows, skipped } = deriveRetroProposalRows(clusters, existingSkillNames);
        const stmts = buildRetroSkillProposalStatements(rows, existingSigs);
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
        return {
            proposals: rows.length,
            skipped,
            clusters: clusters.length,
        };
    });

if (import.meta.main) {
    await Effect.runPromise(
        deriveRetroProposals().pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveRetroProposalsStats>,
    );
}
