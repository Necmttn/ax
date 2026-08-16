import { Effect, Schema } from "effect";
import { CacheRead } from "@ax/lib/duckdb/seam";
import { cacheRows } from "@ax/lib/duckdb/query";
import { NumberFromBigIntColumn, TimestampColumn, JsonArrayColumn } from "@ax/lib/duckdb/columns";
import type {
    ToolFailureDetailPayload,
    ToolFailureEntry,
    ToolFailureRow,
    ToolFailureSample,
    ToolFailureRecommendation,
    ToolFailuresResponse,
} from "@ax/lib/shared/dashboard-types";

// Same GROUP BY strategy as queries/tool-failures.ts (chunk 2b's, not yet
// ported - this is a LOCAL DuckDB translation, not an import, so this module
// never depends on queries/ for its read path): one pass over tool_call,
// enrichment fields (last_error_text/last_project/total_calls) deferred to
// the detail endpoint (correlated subqueries per label were >30s at scale).
// `command_norm ?? name` -> COALESCE; `time::max` -> MAX; `array::len(array::
// distinct(session))` -> COUNT(DISTINCT session); `array::distinct(exit_code)`
// -> to_json(list(DISTINCT ...)) (native LIST columns are banned - see
// @ax/lib/duckdb/columns's module doc - so the array is built as JSON text).
const ToolFailureDbRow = Schema.Struct({
    label: Schema.String,
    failure_count: NumberFromBigIntColumn,
    last_seen: Schema.NullOr(TimestampColumn),
    distinct_sessions: NumberFromBigIntColumn,
    exit_codes: JsonArrayColumn(Schema.Number),
});

const ToolFailureDetailDbRow = Schema.Struct({
    ts: TimestampColumn,
    exit_code: Schema.NullOr(NumberFromBigIntColumn),
    error_text: Schema.NullOr(Schema.String),
    output_excerpt: Schema.NullOr(Schema.String),
    command_text: Schema.NullOr(Schema.String),
    project: Schema.NullOr(Schema.String),
    session_id: Schema.NullOr(Schema.String),
    cwd: Schema.NullOr(Schema.String),
});

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
    never,
    CacheRead
> =>
    Effect.gen(function* () {
        const rows = yield* cacheRows(
            ToolFailureDbRow,
            {
                sql: `SELECT
                        COALESCE(command_norm, name) AS label,
                        count(*) AS failure_count,
                        MAX(ts) AS last_seen,
                        COUNT(DISTINCT session) AS distinct_sessions,
                        COALESCE(to_json(list(DISTINCT exit_code))::VARCHAR, '[]') AS exit_codes
                      FROM tool_call
                      WHERE has_error = true AND COALESCE(command_norm, name) IS NOT NULL
                      GROUP BY label
                      ORDER BY failure_count DESC, last_seen DESC
                      LIMIT 200`,
                params: [],
            },
            "tool-failures.list",
        );
        const failures: ToolFailureEntry[] = [];
        for (const row of rows) {
            if (!row.label) continue;
            const toolFailureRow: ToolFailureRow = {
                label: row.label,
                failure_count: row.failure_count,
                last_seen: row.last_seen ? row.last_seen.toISOString() : null,
                // Deferred to the detail endpoint - see the module doc above.
                last_error_text: null,
                last_project: null,
                distinct_sessions: row.distinct_sessions,
                total_calls: 0,
                failure_rate: 0,
                exit_codes: row.exit_codes,
            };
            const rec = recommendForFailure(toolFailureRow);
            failures.push({
                ...toolFailureRow,
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
): Effect.Effect<ToolFailureDetailPayload, never, CacheRead> =>
    Effect.gen(function* () {
        const rows = yield* cacheRows(
            ToolFailureDetailDbRow,
            {
                sql: `SELECT tc.ts AS ts, tc.exit_code AS exit_code, tc.error_text AS error_text,
                             tc.output_excerpt AS output_excerpt, tc.command_text AS command_text,
                             s.project AS project, s.id AS session_id, tc.cwd AS cwd
                      FROM tool_call tc
                      LEFT JOIN session s ON s.id = tc.session
                      WHERE tc.has_error = true AND COALESCE(tc.command_norm, tc.name) = ?
                      ORDER BY tc.ts DESC
                      LIMIT 10`,
                params: [label],
            },
            "tool-failures.detail",
        );
        const samples: ToolFailureSample[] = rows.map((row) => ({
            ts: row.ts.toISOString(),
            exit_code: row.exit_code,
            error_text: row.error_text,
            output_excerpt: row.output_excerpt,
            command_text: row.command_text,
            project: row.project,
            session_id: row.session_id,
            cwd: row.cwd,
        }));
        return { label, samples };
    });
