/**
 * Project page: everything we know about a single `session.project` value.
 *
 * All queries take a `$project` binding (raw string, e.g.
 * `-Users-necmttn-Projects-quera`). SurrealDB string-equality bindings work
 * fine here - no record-id binding pitfalls.
 *
 * Performance notes:
 *   - `session.project` and `tool_call.session.project` lookups: the
 *     project field is indexed via the session table; queries scoped by it
 *     stay bounded.
 *   - For invocations we filter via `in.session.project`, which the
 *     `invoked` table can index-walk through `in.session`.
 */

/** Overview: session counts, span, source breakdown. */
export const PROJECT_OVERVIEW_SQL = `
SELECT
    project,
    count() AS session_count,
    array::group(source) AS sources,
    time::min(started_at) AS first_session_at,
    time::max(started_at) AS last_session_at
FROM session
WHERE project = $project
GROUP BY project;`;

/** Top skills used in this project. */
export const PROJECT_TOP_SKILLS_SQL = `
SELECT
    out.name AS skill,
    count() AS count,
    time::max(ts) AS last_used
FROM invoked
WHERE in.session.project = $project AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 25;`;

/**
 * Failed-tool roll-up scoped to the project. Mirrors the global
 * /tool-failures shape so the SPA can share the row component.
 */
export const PROJECT_TOP_FAILURES_SQL = `
SELECT
    (command_norm ?? name) AS label,
    count() AS failure_count,
    array::len(array::distinct(session.id)) AS distinct_sessions,
    time::max(ts) AS last_seen
FROM tool_call
WHERE session.project = $project
  AND failure = true
  AND (command_norm ?? name) IS NOT NONE
GROUP BY label
ORDER BY failure_count DESC
LIMIT 15;`;

/** 20 most recent sessions for the project. */
export const PROJECT_RECENT_SESSIONS_SQL = `
SELECT
    id,
    source,
    started_at,
    ended_at,
    model,
    cwd
FROM session
WHERE project = $project
ORDER BY started_at DESC
LIMIT 20;`;

/** Episodes (parent sessions with subagents) inside this project. */
export const PROJECT_EPISODES_SQL = `
SELECT
    in AS parent,
    in.started_at AS started_at,
    count() AS child_count,
    array::len(array::distinct(nickname)) AS distinct_nicknames
FROM spawned
WHERE in.project = $project
GROUP BY parent, started_at
ORDER BY child_count DESC
LIMIT 10;`;
