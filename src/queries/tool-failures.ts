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
