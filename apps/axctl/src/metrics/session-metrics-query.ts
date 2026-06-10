import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";
import { nonEmptyString } from "@ax/lib/shared/derive-keys";
import { fillEstimatedCost, loadPricingCatalogForModels, type UsageCostFields } from "./cost-estimate.ts";
import { sessionRefList } from "./util.ts";

export interface SessionMetricsRow {
    readonly session: string;
    readonly taskLabel: string | null;
    readonly source: string | null;
    readonly durabilityRatio: number | null;
    readonly producedCommits: number;
    readonly timeToLandMs: number | null;
    readonly linesAdded: number;
    readonly linesRemoved: number;
    readonly timeToFirstEditMs: number | null;
    readonly coldStartReads: number;
    readonly delegationRatio: number | null;
    readonly estimatedCostUsd: number | null;
    /** Provenance of `estimatedCostUsd`: the stored `pricing_source` when the
     *  cost was priced at ingest, `estimated:<catalog>` when backfilled at read
     *  time from token counts × model pricing (#175), null when unknown. */
    readonly costPricingSource: string | null;
    readonly userCorrections: number | null;
}

const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const numOrZero = (v: unknown): number => numOrNull(v) ?? 0;
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Snake_case usage row as read back from `session_token_usage`. */
interface TokenUsageRow extends UsageCostFields {
    readonly session: string;
}

/**
 * Batch-fetch the `session_token_usage` rows for the listed sessions (one
 * indexed `session IN [...]` select - `session_token_usage_session` is a
 * UNIQUE index) and resolve each session's cost: stored when priced at ingest,
 * estimated from token counts × `agent_model` pricing otherwise (#175 - the
 * Claude byte-estimate rows were never priced, so every Claude session showed
 * `estimatedCostUsd: null`).
 */
const fetchSessionCosts = (
    sessionIds: readonly string[],
): Effect.Effect<Map<string, { estimatedCostUsd: number | null; pricingSource: string | null }>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const out = new Map<string, { estimatedCostUsd: number | null; pricingSource: string | null }>();
        if (sessionIds.length === 0) return out;
        const db = yield* SurrealClient;
        const usageRows = (yield* db.query<[TokenUsageRow[]]>(
            `SELECT type::string(session) AS session, model, prompt_tokens, completion_tokens,`
            + ` cache_creation_input_tokens, cache_read_input_tokens, estimated_tokens,`
            + ` estimated_cost_usd, pricing_source`
            + ` FROM session_token_usage WHERE session IN [${sessionRefList(sessionIds)}];`,
        ))?.[0] ?? [];
        const catalog = yield* loadPricingCatalogForModels(usageRows.map((u) => u.model));
        for (const usage of usageRows) {
            const filled = fillEstimatedCost({
                model: strOrNull(usage.model),
                prompt_tokens: numOrNull(usage.prompt_tokens),
                completion_tokens: numOrNull(usage.completion_tokens),
                cache_creation_input_tokens: numOrNull(usage.cache_creation_input_tokens),
                cache_read_input_tokens: numOrNull(usage.cache_read_input_tokens),
                estimated_tokens: numOrZero(usage.estimated_tokens),
                estimated_cost_usd: numOrNull(usage.estimated_cost_usd),
                pricing_source: strOrNull(usage.pricing_source),
            }, catalog);
            out.set(String(usage.session), {
                estimatedCostUsd: filled.estimatedCostUsd,
                pricingSource: filled.pricingSource,
            });
        }
        return out;
    });

export const fetchSessionMetrics = (
    input: { readonly since: Date | null; readonly limit: number; readonly project?: string | null },
): Effect.Effect<SessionMetricsRow[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = Math.min(Math.max(input.limit, 1), 500);
        const clauses: string[] = [];
        if (input.since) clauses.push(`session.started_at >= ${surrealDate(input.since)}`);
        if (input.project) {
            const project = surrealString(input.project);
            clauses.push(`(session.project = ${project} OR session.cwd = ${project})`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(session) AS session,
  session.source AS source,
  durability_ratio, produced_commits, time_to_land_ms, lines_added, lines_removed,
  time_to_first_edit_ms, cold_start_reads, delegation_ratio,
  (SELECT task_label FROM session_health WHERE session = $parent.session LIMIT 1)[0].task_label AS task_label,
  (SELECT user_corrections FROM session_health WHERE session = $parent.session LIMIT 1)[0].user_corrections AS user_corrections
FROM session_metrics
${where}
-- Lead with sessions that did real committing work (NONE-durability rows - 0-commit
-- review/agent sessions - otherwise sort first under plain ASC and bury the signal),
-- then most-fragile-first within them.
ORDER BY produced_commits DESC, durability_ratio ASC
LIMIT ${limit};`))?.[0] ?? [];
        const costs = yield* fetchSessionCosts(rows.map((r) => String(r.session ?? "")).filter((s) => s.length > 0));
        return rows.map((r) => {
            const session = String(r.session ?? "");
            const cost = costs.get(session) ?? null;
            return {
                session,
                taskLabel: nonEmptyString(r.task_label),
                source: nonEmptyString(r.source),
                durabilityRatio: numOrNull(r.durability_ratio),
                producedCommits: numOrZero(r.produced_commits),
                timeToLandMs: numOrNull(r.time_to_land_ms),
                linesAdded: numOrZero(r.lines_added),
                linesRemoved: numOrZero(r.lines_removed),
                timeToFirstEditMs: numOrNull(r.time_to_first_edit_ms),
                coldStartReads: numOrZero(r.cold_start_reads),
                delegationRatio: numOrNull(r.delegation_ratio),
                estimatedCostUsd: cost?.estimatedCostUsd ?? null,
                costPricingSource: cost?.pricingSource ?? null,
                userCorrections: numOrNull(r.user_corrections),
            };
        });
    });
