import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import {
    TOOL_FAILURES_SQL,
    TOOL_FAILURE_DETAIL_SQL,
} from "../queries/tool-failures.ts";
import type {
    ToolFailureDetailPayload,
    ToolFailureEntry,
    ToolFailureRow,
    ToolFailureSample,
    ToolFailureRecommendation,
    ToolFailuresResponse,
} from "../lib/shared/dashboard-types.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";

const numericField = (row: Record<string, unknown>, key: string): number => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
};

const stringField = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    return typeof value === "string" && value.length > 0 ? value : null;
};

const dateField = (row: Record<string, unknown>, key: string): string | null => {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    if (value && typeof value === "object" && "toJSON" in value) {
        const json = (value as { toJSON: () => unknown }).toJSON();
        if (typeof json === "string" && json.length > 0) return json;
    }
    return null;
};

const intArrayField = (
    row: Record<string, unknown>,
    key: string,
): ReadonlyArray<number> => {
    const value = row[key];
    if (!Array.isArray(value)) return [];
    return value
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n));
};

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

const coerceRow = (raw: Record<string, unknown>): ToolFailureRow => {
    const failure = numericField(raw, "failure_count");
    const total = numericField(raw, "total_calls");
    const rate = total > 0 ? failure / total : 0;
    return {
        label: String(raw.label ?? "(unknown)"),
        failure_count: failure,
        last_seen: dateField(raw, "last_seen"),
        last_error_text: stringField(raw, "last_error_text"),
        last_project: stringField(raw, "last_project"),
        distinct_sessions: numericField(raw, "distinct_sessions"),
        total_calls: total,
        // SurrealDB may return failure_rate as null when total_calls is 0;
        // recompute client-side as a guard.
        failure_rate: rate,
        exit_codes: intArrayField(raw, "exit_codes"),
    };
};

export const fetchToolFailures = (): Effect.Effect<
    ToolFailuresResponse,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            TOOL_FAILURES_SQL,
        );
        const failures: ToolFailureEntry[] = [];
        for (const raw of result?.[0] ?? []) {
            const row = coerceRow(raw);
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

const coerceSample = (raw: Record<string, unknown>): ToolFailureSample | null => {
    const ts = dateField(raw, "ts");
    if (!ts) return null;
    const exitRaw = raw.exit_code;
    const sessionRaw = raw.session_id;
    return {
        ts,
        exit_code:
            typeof exitRaw === "number" && Number.isFinite(exitRaw)
                ? exitRaw
                : null,
        error_text: stringField(raw, "error_text"),
        output_excerpt: stringField(raw, "output_excerpt"),
        command_text: stringField(raw, "command_text"),
        project: stringField(raw, "project"),
        // Bare session id over the HTTP seam; see src/lib/shared/session-id.ts.
        session_id:
            typeof sessionRaw === "string"
                ? toBareSessionId(sessionRaw)
                : sessionRaw && typeof sessionRaw === "object" && "toString" in sessionRaw
                  ? toBareSessionId(String(sessionRaw))
                  : null,
        cwd: stringField(raw, "cwd"),
    };
};

export const fetchToolFailureDetail = (
    label: string,
): Effect.Effect<ToolFailureDetailPayload, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            TOOL_FAILURE_DETAIL_SQL,
            { label },
        );
        const samples: ToolFailureSample[] = [];
        for (const raw of result?.[0] ?? []) {
            const parsed = coerceSample(raw);
            if (parsed) samples.push(parsed);
        }
        return { label, samples };
    });
