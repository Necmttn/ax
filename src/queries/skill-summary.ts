/**
 * Skill leaderboard SQL. Used by the TUI, CLI taste view, and the dashboard
 * `/api/skills` endpoint. Kept centralised so the score formula stays in sync
 * across surfaces.
 *
 * taste_score = total_inv - 2*corrections + commits_after - 0.5*proposals
 *
 * See `src/tui/queries.ts` history for perf notes (#31, #33): denormalised
 * `was_corrected` flag on the `invoked` edge + `time::max(ts)` aggregate
 * instead of per-row subqueries.
 */
export const SKILL_SUMMARY_SQL = `
SELECT
    name,
    scope,
    description,
    dir_path,
    bytes,
    total_inv,
    inv_7d,
    inv_30d,
    last_used,
    corrections,
    proposals,
    -- One discriminating fact per row: most recent project this skill ran
    -- in. The (out, ts) index on \`invoked\` makes this LIMIT-1 lookup
    -- cheap (147 outer rows * 1 indexed seek). SurrealDB requires the ORDER
    -- BY column be in the projection, hence the explicit \`ts\`.
    (SELECT in.session.project AS project, ts FROM invoked WHERE out.name = $parent.name ORDER BY ts DESC LIMIT 1)[0].project AS last_project,
    array::len((SELECT id FROM produced WHERE in IN $parent.skill_sessions)) AS commits_after,
    (
        total_inv
        - 2 * corrections
        + array::len((SELECT id FROM produced WHERE in IN $parent.skill_sessions))
        - 0.5 * proposals
    ) AS taste_score
FROM (
    SELECT
        skill_id.name AS name,
        skill_id.scope AS scope,
        skill_id.description AS description,
        skill_id.dir_path AS dir_path,
        skill_id.bytes AS bytes,
        total_inv,
        inv_7d,
        inv_30d,
        corrections,
        last_used,
        array::len(skill_id<-proposed) AS proposals,
        array::distinct(skill_id<-invoked.in.session ?? []) AS skill_sessions
    FROM (
        SELECT
            out AS skill_id,
            count() AS total_inv,
            math::sum(IF ts > time::now() - 7d  THEN 1 ELSE 0 END) AS inv_7d,
            math::sum(IF ts > time::now() - 30d THEN 1 ELSE 0 END) AS inv_30d,
            math::sum(IF was_corrected = true THEN 1 ELSE 0 END) AS corrections,
            time::max(ts) AS last_used
        FROM invoked
        GROUP BY out
    )
    WHERE skill_id.name IS NOT NONE
)
ORDER BY taste_score DESC, inv_30d DESC, total_inv DESC
LIMIT 500;`;

/** Skills with `proposed` edges but no `invoked` edges. Union with the main
 *  scan on the JS side. */
export const SKILL_SUMMARY_PROPOSED_ONLY_SQL = `
SELECT
    name,
    scope,
    description,
    dir_path,
    bytes,
    0 AS total_inv,
    0 AS inv_7d,
    0 AS inv_30d,
    NONE AS last_used,
    NONE AS last_project,
    0 AS corrections,
    array::len(<-proposed) AS proposals,
    0 AS commits_after,
    -0.5 * array::len(<-proposed) AS taste_score
FROM skill
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) > 0;`;
