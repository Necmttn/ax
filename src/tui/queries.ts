/**
 * SurrealQL query strings used by the TUI dashboard. Kept centralised so
 * shape changes propagate in one place. All queries return JSON-friendly
 * shapes; we don't rely on RecordIds inside the UI.
 */

/**
 * Per-skill summary used by the SkillList. One row per skill, with
 * usage counters that the list sorts on.
 */
// NOTE: Time-window counts use explicit `invoked WHERE out = $parent.id`
// form rather than `<-invoked WHERE ts > ...`. The graph-traversal form
// materialises the edges first and the WHERE filter then drops every row
// (returns 0 even when matches exist). See issue #15.
//
// taste_score = invocations - 2*corrections + commits_after - 0.5*proposals
// Mirrors the formula in `cmdTaste` (src/cli/index.ts) - keep in sync.
//
// Two-stage SELECT: the inner picks skill columns plus the cheap graph
// traversal `<-invoked.in.session` to materialise the distinct session set
// per skill. The outer counts `produced` edges from those sessions and
// combines into the score. The traversal form is ~30x faster than
// `(SELECT VALUE in.session FROM invoked WHERE out = $parent.id)` because
// it uses graph storage rather than a full `invoked` table scan.
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
    array::len((SELECT id FROM produced WHERE in IN $parent.skill_sessions)) AS commits_after,
    (
        total_inv
        - 2 * corrections
        + array::len((SELECT id FROM produced WHERE in IN $parent.skill_sessions))
        - 0.5 * proposals
    ) AS taste_score
FROM (
    SELECT
        name,
        scope,
        description,
        dir_path,
        bytes,
        array::distinct(<-invoked.in.session) AS skill_sessions,
        array::len(<-invoked) AS total_inv,
        array::len(<-proposed) AS proposals,
        (SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - 7d  GROUP ALL)[0].count ?? 0 AS inv_7d,
        (SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - 30d GROUP ALL)[0].count ?? 0 AS inv_30d,
        (SELECT ts FROM invoked WHERE out = $parent.id ORDER BY ts DESC LIMIT 1)[0].ts AS last_used,
        array::len((
            SELECT * FROM invoked
            WHERE out = $parent.id
              AND array::len((
                SELECT * FROM corrected_by
                WHERE in.session = $parent.in.session
                  AND in.seq >= $parent.in.seq
                  AND in.seq <= $parent.in.seq + 3
            )) > 0
        )) AS corrections
    FROM skill
)
ORDER BY taste_score DESC, inv_30d DESC, total_inv DESC
LIMIT 500;`;

/**
 * Detail payload for a single skill: skill metadata (no body - read from
 * dir_path on the JS side) + per-day invocation buckets for the last 30 days
 * + recent invocation list.
 *
 * Bindings: $name (skill name).
 */
export const SKILL_DETAIL_SQL = `
LET $s = (SELECT * FROM skill WHERE name = $name)[0];
RETURN {
    skill: $s,
    invocations: {
        total: array::len((SELECT * FROM invoked WHERE out = $s.id)),
        d7:    array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 7d)),
        d30:   array::len((SELECT * FROM invoked WHERE out = $s.id AND ts > time::now() - 30d)),
        last:  (SELECT ts FROM invoked WHERE out = $s.id ORDER BY ts DESC LIMIT 1)[0].ts,
    },
    recent: (
        SELECT ts, in.session.project AS project
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 10
    ),
    daily: (
        SELECT ts FROM invoked
        WHERE out = $s.id AND ts > time::now() - 30d
        ORDER BY ts ASC
    )
};`;
