/**
 * Per-session deep view. Each subquery is bounded by the session id so the
 * cost stays in the session-touching indexes. Used by /api/sessions/:id and
 * the dashboard's session-detail page.
 *
 * Bindings: $sessionId (record reference, e.g. session:⟨…⟩).
 */
export const SESSION_OVERVIEW_SQL = `
SELECT
    id,
    project,
    cwd,
    model,
    source,
    started_at,
    ended_at
FROM $sessionId;`;

export const SESSION_TOP_SKILLS_SQL = `
SELECT
    out.name AS skill,
    count() AS count,
    time::max(ts) AS last_used
FROM invoked
WHERE in.session = $sessionId AND out.name IS NOT NONE
GROUP BY skill
ORDER BY count DESC
LIMIT 20;`;

export const SESSION_TOOL_CALLS_SQL = `
SELECT
    (command_norm ?? name) AS label,
    count() AS count,
    math::sum(IF has_error = true THEN 1 ELSE 0 END) AS failures,
    time::max(ts) AS last_used
FROM tool_call
WHERE session = $sessionId AND (command_norm ?? name) IS NOT NONE
GROUP BY label
ORDER BY count DESC
LIMIT 25;`;

export const SESSION_CHILDREN_SQL = `
SELECT
    out AS child,
    out.project AS project,
    out.started_at AS started_at,
    nickname,
    tool,
    ts
FROM spawned
WHERE in = $sessionId
ORDER BY ts ASC
LIMIT 100;`;

export const SESSION_PARENT_SQL = `
SELECT
    in AS parent,
    in.project AS project,
    in.started_at AS started_at,
    nickname,
    tool,
    ts
FROM spawned
WHERE out = $sessionId
LIMIT 1;`;

/**
 * Claude `Agent` tool calls. Each is one inline subagent dispatch - there's
 * no separate session record but the prompt + result still tell us *what*
 * was delegated.
 */
export const SESSION_AGENT_DELEGATIONS_SQL = `
SELECT
    id,
    ts,
    input_json,
    output_excerpt
FROM tool_call
WHERE session = $sessionId AND name = "Agent"
ORDER BY ts ASC
LIMIT 50;`;
