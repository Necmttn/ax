import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";
import { nonEmptyString } from "@ax/lib/shared/derive-keys";
import { fetchSessionCostMap } from "./cost-estimate.ts";
import { chunked, cleanSessionId, numOrNull, numOrZero, sessionRefList, strOrNull } from "./util.ts";
import { sessionProjectClause } from "./session-filter.ts";

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

// ---------------------------------------------------------------------------
// Shared session→health map (batch lookup - never correlated per-row subqueries)
// ---------------------------------------------------------------------------

/** The `session_health` scalars the metrics surfaces join in. */
export interface SessionHealthEntry {
    readonly taskLabel: string | null;
    readonly userCorrections: number | null;
}

const HEALTH_SELECT =
    `SELECT type::string(session) AS session, task_label, user_corrections FROM session_health`;

/** Max record refs per `session IN [...]` batch (keeps query strings sane). */
const IN_CHUNK = 500;

/**
 * Batch-fetch `session_health` scalars. `sessionIds === null` scans the whole
 * table (aggregate fallback when the session set is too large to enumerate);
 * otherwise the select is bounded via the UNIQUE `session_health_session`
 * index in `IN_CHUNK`-sized batches. Keys are normalized with
 * `cleanSessionId` - look up with the same.
 */
export const fetchSessionHealthMap = (
    sessionIds: readonly string[] | null,
): Effect.Effect<Map<string, SessionHealthEntry>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const out = new Map<string, SessionHealthEntry>();
        if (sessionIds !== null && sessionIds.length === 0) return out;
        const db = yield* SurrealClient;
        const rows = sessionIds === null
            ? (yield* db.query<[Array<Record<string, unknown>>]>(`${HEALTH_SELECT};`))?.[0] ?? []
            : (yield* Effect.all(
                chunked(sessionIds, IN_CHUNK).map((ids) =>
                    db.query<[Array<Record<string, unknown>>]>(`${HEALTH_SELECT} WHERE session IN [${sessionRefList(ids)}];`)),
                { concurrency: 4 },
            )).flatMap((batch) => batch?.[0] ?? []);
        for (const r of rows) {
            out.set(cleanSessionId(String(r.session ?? "")), {
                taskLabel: strOrNull(r.task_label),
                userCorrections: numOrNull(r.user_corrections),
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
        if (input.project) clauses.push(sessionProjectClause(input.project, "session."));
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT
  type::string(session) AS session,
  session.source AS source,
  durability_ratio, produced_commits, time_to_land_ms, lines_added, lines_removed,
  time_to_first_edit_ms, cold_start_reads, delegation_ratio
FROM session_metrics
${where}
-- Lead with sessions that did real committing work (NONE-durability rows - 0-commit
-- review/agent sessions - otherwise sort first under plain ASC and bury the signal),
-- then most-fragile-first within them.
ORDER BY produced_commits DESC, durability_ratio ASC
LIMIT ${limit};`))?.[0] ?? [];
        // Health + cost join only the ≤500 returned sessions, fetched as TWO
        // indexed batch lookups (not correlated per-row subqueries evaluated
        // before ORDER/LIMIT) and run concurrently - they are independent.
        const sessionIds = rows.map((r) => String(r.session ?? "")).filter((s) => s.length > 0);
        const [costs, health] = yield* Effect.all([
            fetchSessionCostMap(sessionIds),
            fetchSessionHealthMap(sessionIds),
        ], { concurrency: 2 });
        return rows.map((r) => {
            const session = String(r.session ?? "");
            const key = cleanSessionId(session);
            const cost = costs.get(key) ?? null;
            const h = health.get(key) ?? null;
            return {
                session,
                taskLabel: h?.taskLabel ?? null,
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
                userCorrections: h?.userCorrections ?? null,
            };
        });
    });
