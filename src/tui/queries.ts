/**
 * SurrealQL query strings used by the TUI dashboard. Kept centralised so
 * shape changes propagate in one place. All queries return JSON-friendly
 * shapes; we don't rely on RecordIds inside the UI.
 */

/**
 * Per-skill summary used by the SkillList. One row per skill, with
 * usage counters that the list sorts on.
 */
export const SKILL_SUMMARY_SQL = `
SELECT
    name,
    scope,
    description,
    dir_path,
    bytes,
    array::len(<-invoked) AS total_inv,
    array::len((SELECT * FROM <-invoked WHERE ts > time::now() - 7d))  AS inv_7d,
    array::len((SELECT * FROM <-invoked WHERE ts > time::now() - 30d)) AS inv_30d,
    (SELECT ts FROM <-invoked ORDER BY ts DESC LIMIT 1)[0].ts AS last_used
FROM skill
ORDER BY inv_30d DESC, total_inv DESC
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
