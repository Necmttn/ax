/**
 * Tool failure aggregation. Powers the dashboard `/tools` view + the
 * "evidence: what failed" panel.
 *
 * Strategy:
 *  - GROUP BY (command_norm OR name) so codex `apply_patch`, `exec_command`,
 *    bash `git push`, etc. each collapse to one row.
 *  - Pull `last_seen`, `last_error_text`, `last_project`, `distinct_sessions`,
 *    and `total_calls` so the user can read "is this still happening?".
 *
 * The (has_error, ts) index keeps the WHERE clause cheap.
 */
import { defineQuery } from "./query.ts";
import { isRecord, stringField, dateField, numberField } from "../lib/shared/row-fields.ts";
import { toBareSessionId } from "../lib/shared/session-id.ts";
import type { ToolFailureRow, ToolFailureSample } from "../lib/shared/dashboard-types.ts";

// Single GROUP BY pass over the (has_error, ts) index. Enrichment fields
// (last_error_text, last_project, total_calls) are deferred to the detail
// endpoint -- correlated subqueries per label across ~600k tool_call rows
// took >30s in dogfood. The table view only needs failure_count + last_seen
// + distinct_sessions to be useful; the user gets the rest on expand.
export const TOOL_FAILURES_SQL = `
SELECT
    (command_norm ?? name) AS label,
    count() AS failure_count,
    time::max(ts) AS last_seen,
    array::len(array::distinct(session)) AS distinct_sessions,
    array::distinct(exit_code) AS exit_codes
FROM tool_call
WHERE has_error = true AND (command_norm ?? name) IS NOT NONE
GROUP BY label
ORDER BY failure_count DESC, last_seen DESC
LIMIT 200;`;

/**
 * Per-command failure detail: last N error rows. Bindings: $label (the
 * grouped command_norm/name).
 */
export const TOOL_FAILURE_DETAIL_SQL = `
SELECT
    ts,
    exit_code,
    error_text,
    output_excerpt,
    command_text,
    session.project AS project,
    session.id AS session_id,
    cwd
FROM tool_call
WHERE has_error = true AND (command_norm ?? name) = $label
ORDER BY ts DESC
LIMIT 10;`;

// ---------------------------------------------------------------------------
// Typed Query seam
// ---------------------------------------------------------------------------

const numF = (row: Record<string, unknown>, key: string): number =>
    numberField(row, key) ?? 0;

const intArrayField = (row: Record<string, unknown>, key: string): ReadonlyArray<number> => {
    const value = row[key];
    if (!Array.isArray(value)) return [];
    return value.map((v) => Number(v)).filter((n) => Number.isFinite(n));
};

export const toolFailuresQuery = defineQuery<
    Record<string, never>,
    Record<string, unknown>,
    ToolFailureRow | null
>({
    name: "tool-failures.list",
    sql: () => TOOL_FAILURES_SQL,
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
        const failure = numF(raw, "failure_count");
        const total = numF(raw, "total_calls");
        const rate = total > 0 ? failure / total : 0;
        return {
            label: String(raw.label ?? "(unknown)"),
            failure_count: failure,
            last_seen: dateField(raw, "last_seen"),
            last_error_text: stringField(raw, "last_error_text"),
            last_project: stringField(raw, "last_project"),
            distinct_sessions: numF(raw, "distinct_sessions"),
            total_calls: total,
            failure_rate: rate,
            exit_codes: intArrayField(raw, "exit_codes"),
        };
    },
});

export interface ToolFailureDetailParams {
    readonly label: string;
}

export const toolFailureDetailQuery = defineQuery<
    ToolFailureDetailParams,
    Record<string, unknown>,
    ToolFailureSample | null
>({
    name: "tool-failures.detail",
    sql: () => TOOL_FAILURE_DETAIL_SQL,
    bindings: (p) => ({ label: p.label }),
    mapRow: (raw) => {
        if (!isRecord(raw)) return null;
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
    },
});
