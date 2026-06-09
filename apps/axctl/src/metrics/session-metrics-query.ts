import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";
import { nonEmptyString } from "@ax/lib/shared/derive-keys";

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
    readonly userCorrections: number | null;
}

const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const numOrZero = (v: unknown): number => numOrNull(v) ?? 0;

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
  (SELECT user_corrections FROM session_health WHERE session = $parent.session LIMIT 1)[0].user_corrections AS user_corrections,
  (SELECT estimated_cost_usd FROM session_token_usage WHERE session = $parent.session LIMIT 1)[0].estimated_cost_usd AS estimated_cost_usd
FROM session_metrics
${where}
-- Lead with sessions that did real committing work (NONE-durability rows - 0-commit
-- review/agent sessions - otherwise sort first under plain ASC and bury the signal),
-- then most-fragile-first within them.
ORDER BY produced_commits DESC, durability_ratio ASC
LIMIT ${limit};`))?.[0] ?? [];
        return rows.map((r) => ({
            session: String(r.session ?? ""),
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
            estimatedCostUsd: numOrNull(r.estimated_cost_usd),
            userCorrections: numOrNull(r.user_corrections),
        }));
    });
