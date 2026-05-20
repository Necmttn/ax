import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    toolFailuresQuery,
    toolFailureDetailQuery,
} from "../queries/tool-failures.ts";
import type {
    ToolFailureDetailPayload,
    ToolFailureEntry,
    ToolFailureRow,
    ToolFailureSample,
    ToolFailureRecommendation,
    ToolFailuresResponse,
} from "../lib/shared/dashboard-types.ts";
import { runQuery } from "../lib/shared/graph-query.ts";

const HIGH_FAILURE_COUNT = 5;
const RECENT_DAYS = 14;

/**
 * Decide what to do about a failing command. Cheap rules; the dashboard
 * shows the rationale next to the badge so the user can override.
 *
 * `total_calls` is intentionally NOT used here -- computing it requires a
 * full per-label scan of `tool_call` and made `/api/tool-failures` >30s.
 * Recommendation runs on failure_count + recency + session breadth alone.
 */
export function recommendForFailure(row: ToolFailureRow): {
    readonly recommendation: ToolFailureRecommendation;
    readonly reason: string;
} {
    const recent = row.last_seen
        ? Date.now() - Date.parse(row.last_seen) <= RECENT_DAYS * 86400_000
        : false;
    const sessions = row.distinct_sessions;

    if (row.failure_count >= HIGH_FAILURE_COUNT && recent && sessions >= 2) {
        return {
            recommendation: "fix",
            reason: `${row.failure_count} failures across ${sessions} sessions, recent - likely actionable`,
        };
    }
    if (recent && row.failure_count >= 2) {
        return {
            recommendation: "watch",
            reason: `${row.failure_count} recent failures in ${sessions} session(s) - keep an eye`,
        };
    }
    if (!recent) {
        return {
            recommendation: "ignore",
            reason: `last failure >${RECENT_DAYS}d ago - probably stale`,
        };
    }
    return {
        recommendation: "watch",
        reason: `${row.failure_count} failures - low signal, may be transient`,
    };
}

export const fetchToolFailures = (): Effect.Effect<
    ToolFailuresResponse,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const mapped = yield* runQuery(toolFailuresQuery, {} as Record<string, never>);
        const failures: ToolFailureEntry[] = [];
        for (const row of mapped) {
            if (!row) continue;
            if (!row.label) continue;
            const rec = recommendForFailure(row);
            failures.push({
                ...row,
                recommendation: rec.recommendation,
                recommendation_reason: rec.reason,
            });
        }
        return {
            generatedAt: new Date().toISOString(),
            failures,
        };
    });

export const fetchToolFailureDetail = (
    label: string,
): Effect.Effect<ToolFailureDetailPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const mapped = yield* runQuery(toolFailureDetailQuery, { label });
        const samples: ToolFailureSample[] = mapped.filter(
            (s): s is ToolFailureSample => s !== null,
        );
        return { label, samples };
    });
