import { Effect, Schema } from "effect";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import type { CacheReadError, CacheReadService } from "@ax/lib/duckdb/seam";
import { sinceClause } from "@ax/lib/duckdb/clause";
import { nonEmptyString } from "@ax/lib/shared/derive-keys";
import { fetchSessionCostMap } from "./cost-estimate.ts";
import { chunked, cleanSessionId, sessionIdsClause } from "./util.ts";
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
    `SELECT session, task_label, user_corrections FROM session_health`;

const SessionHealthRow = Schema.Struct({
    session: Schema.String,
    task_label: Schema.NullOr(Schema.String),
    user_corrections: Schema.NullOr(NumberFromBigIntColumn),
});

const SessionMetricsDbRow = Schema.Struct({
    session: Schema.String,
    source: Schema.String,
    durability_ratio: Schema.NullOr(Schema.Number),
    produced_commits: NumberFromBigIntColumn,
    time_to_land_ms: Schema.NullOr(NumberFromBigIntColumn),
    lines_added: NumberFromBigIntColumn,
    lines_removed: NumberFromBigIntColumn,
    time_to_first_edit_ms: Schema.NullOr(NumberFromBigIntColumn),
    cold_start_reads: NumberFromBigIntColumn,
    delegation_ratio: Schema.NullOr(Schema.Number),
});

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
    read: CacheReadService,
    sessionIds: readonly string[] | null,
): Effect.Effect<Map<string, SessionHealthEntry>, CacheReadError> =>
    Effect.gen(function* () {
        const out = new Map<string, SessionHealthEntry>();
        if (sessionIds !== null && sessionIds.length === 0) return out;
        const rows = sessionIds === null
            ? yield* read.rows(SessionHealthRow, HEALTH_SELECT)
            : (yield* Effect.all(
                chunked(sessionIds, IN_CHUNK).map((ids) => {
                    const sessions = sessionIdsClause("session", ids);
                    return read.rows(SessionHealthRow, `${HEALTH_SELECT} WHERE TRUE ${sessions.sql}`, sessions.params);
                }),
                { concurrency: 4 },
            )).flatMap((batch) => batch);
        for (const r of rows) {
            out.set(cleanSessionId(r.session), {
                taskLabel: r.task_label,
                userCorrections: r.user_corrections,
            });
        }
        return out;
    });

export const fetchSessionMetrics = (
    read: CacheReadService,
    input: { readonly since: Date | null; readonly limit: number; readonly project?: string | null },
): Effect.Effect<SessionMetricsRow[], CacheReadError> =>
    Effect.gen(function* () {
        const limit = Math.min(Math.max(input.limit, 1), 500);
        const since = sinceClause("s.started_at", input.since);
        const project = input.project ? sessionProjectClause(input.project, "s.") : { sql: "", params: [] };
        const rows = yield* read.rows(SessionMetricsDbRow, `
SELECT
  m.session AS session,
  s.source AS source,
  m.durability_ratio, m.produced_commits, m.time_to_land_ms, m.lines_added, m.lines_removed,
  m.time_to_first_edit_ms, m.cold_start_reads, m.delegation_ratio
FROM session_metrics m
JOIN session s ON s.id = m.session
WHERE TRUE ${since.sql} ${project.sql}
-- Lead with sessions that did real committing work (NONE-durability rows - 0-commit
-- review/agent sessions - otherwise sort first under plain ASC and bury the signal),
-- then most-fragile-first within them.
ORDER BY m.produced_commits DESC, m.durability_ratio ASC
LIMIT ?`, [...since.params, ...project.params, limit]);
        // Health + cost join only the ≤500 returned sessions, fetched as TWO
        // indexed batch lookups (not correlated per-row subqueries evaluated
        // before ORDER/LIMIT) and run concurrently - they are independent.
        const sessionIds = rows.map((r) => String(r.session ?? "")).filter((s) => s.length > 0);
        const [costs, health] = yield* Effect.all([
            fetchSessionCostMap(read, sessionIds),
            fetchSessionHealthMap(read, sessionIds),
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
                durabilityRatio: r.durability_ratio,
                producedCommits: r.produced_commits,
                timeToLandMs: r.time_to_land_ms,
                linesAdded: r.lines_added,
                linesRemoved: r.lines_removed,
                timeToFirstEditMs: r.time_to_first_edit_ms,
                coldStartReads: r.cold_start_reads,
                delegationRatio: r.delegation_ratio,
                estimatedCostUsd: cost?.estimatedCostUsd ?? null,
                costPricingSource: cost?.pricingSource ?? null,
                userCorrections: h?.userCorrections ?? null,
            };
        });
    });
