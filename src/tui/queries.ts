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
export const SKILL_SUMMARY_SQL = `
SELECT
    name,
    scope,
    description,
    dir_path,
    bytes,
    array::len(<-invoked) AS total_inv,
    (SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - 7d  GROUP ALL)[0].count ?? 0 AS inv_7d,
    (SELECT count() FROM invoked WHERE out = $parent.id AND ts > time::now() - 30d GROUP ALL)[0].count ?? 0 AS inv_30d,
    (SELECT ts FROM invoked WHERE out = $parent.id ORDER BY ts DESC LIMIT 1)[0].ts AS last_used
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
