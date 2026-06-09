/**
 * "How does my work look this week, and how is it changing?"
 *
 * Three queries:
 *   - WORKFLOW_WEEKLY_SKILLS_SQL: counts of every skill invocation per ISO
 *     week for the last N weeks. Used to build the heatmap and the top-K
 *     convergence index.
 *   - WORKFLOW_WEEKLY_TOOLS_SQL: same shape but per command_norm (tools).
 *   - WORKFLOW_SESSION_SHAPE_SQL: per-week session count + avg tool calls /
 *     turns / corrections per session. Helps tell "are sessions getting
 *     longer / messier / cleaner over time".
 *
 * All three filter on `ts > time::now() - {N}w` so cold scans stay bounded.
 *
 * Bindings: $weeks (number, default 12 if absent).
 */

const W = 12; // default lookback - keep in sync with WEEKS_LOOKBACK below
export const WEEKS_LOOKBACK = W;

// ISO 8601 year-week (e.g. "2026-W19") so weeks align across year boundaries.
// SurrealDB's `time::group` doesn't accept "week" so we format-then-group.
export const WORKFLOW_WEEKLY_SKILLS_SQL = `
SELECT
    time::format(ts, "%G-W%V") AS week,
    out.name AS skill,
    count() AS count
FROM invoked
WHERE ts > time::now() - ${W}w AND out.name IS NOT NONE
GROUP BY week, skill
ORDER BY week ASC, count DESC;`;

export const WORKFLOW_WEEKLY_TOOLS_SQL = `
SELECT
    time::format(ts, "%G-W%V") AS week,
    (command_norm ?? name) AS label,
    count() AS count
FROM tool_call
WHERE ts > time::now() - ${W}w AND (command_norm ?? name) IS NOT NONE
GROUP BY week, label
ORDER BY week ASC, count DESC;`;

export const WORKFLOW_SESSION_SHAPE_SQL = `
SELECT
    time::format(started_at, "%G-W%V") AS week,
    count() AS session_count
FROM session
WHERE started_at > time::now() - ${W}w
GROUP BY week
ORDER BY week ASC;`;

/**
 * Latest precomputed workflow payload. The live endpoint should read this
 * single row; refresh/benchmark jobs own the expensive aggregate rebuild.
 * This replaces the endpoint-time WORKFLOW_SESSION_SEQUENCES_SQL and
 * WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL global invoked scans that were
 * dominating /api/workflow latency on large local datasets.
 */
export const WORKFLOW_SNAPSHOT_SQL = `
SELECT payload
FROM workflow_snapshot:latest
LIMIT 1;`;

/**
 * Top "work episodes" - parent sessions that spawned >= 1 subagent. Returns
 * the parent's id/project/started_at plus how many descendants it had. Real
 * orchestrators surface as 50+ children; one-off Task calls drop in the tail.
 */
export const WORKFLOW_EPISODES_SQL = `
SELECT
    in AS parent,
    in.project AS project,
    in.started_at AS started_at,
    count() AS child_count,
    array::len(array::distinct(nickname)) AS distinct_nicknames
FROM spawned
GROUP BY parent, project, started_at
ORDER BY child_count DESC
LIMIT 25;`;

/**
 * Flat (session, skill, ts) rows scoped to **orchestrator** sessions only
 * (excludes claude-subagent sessions, which are sub-tasks within an episode).
 * Used to compute "your typical session" shapes - subagents would dominate
 * with single-skill noise. Episode-level shapes have their own query.
 */
/** Parent → child mapping (cheap; spawned is ~2000 rows). */
export const WORKFLOW_EPISODE_PAIRS_SQL = `
SELECT in AS parent, out AS child FROM spawned;`;

/**
 * First invocation of each skill in each subagent session. This keeps episode
 * shapes as "which workflow phases appeared, and in what first-use order"
 * without replaying every repeated invocation across all subagent turns.
 */
export const WORKFLOW_EPISODE_SUBAGENT_INVOCATIONS_SQL = `
SELECT
    in.session AS session,
    out.name AS skill,
    turn_index,
    ts
FROM invoked
WHERE is_first = true
  AND in.session IS NOT NONE
  AND out.name IS NOT NONE
  AND in.session.source = "claude-subagent"
LIMIT 100000;`;

export const WORKFLOW_SESSION_SEQUENCES_SQL = `
SELECT
    in.session AS session,
    out.name AS skill,
    turn_index,
    ts
FROM invoked
WHERE ts > time::now() - ${W}w
  AND is_first = true
  AND in.session IS NOT NONE
  AND out.name IS NOT NONE
  AND in.session.source != "claude-subagent"
ORDER BY session ASC, turn_index ASC
LIMIT 50000;`;
