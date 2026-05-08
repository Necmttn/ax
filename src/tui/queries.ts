/**
 * SurrealQL query strings used by the TUI dashboard. Kept centralised so
 * shape changes propagate in one place. All queries return JSON-friendly
 * shapes; we don't rely on RecordIds inside the UI.
 */

/**
 * Per-skill summary used by the SkillList. One row per skill, with
 * usage counters that the list sorts on.
 */
// taste_score = invocations - 2*corrections + commits_after - 0.5*proposals
// Mirrors the formula in `cmdTaste` (src/cli/index.ts) - keep in sync.
//
// PERF (issue #31): The previous form ran one correlated subquery per skill
// for inv_7d / inv_30d / clean_inv / corrections, each forcing a per-row
// record fetch through the `in` link. On the largest skill (~500k edges)
// the corrections subquery alone took ~24s. We now denormalise the source
// turn's `has_error` and a "+3 seq window" `was_corrected` flag onto the
// `invoked` edge at ingest / derive-signals time, so a single
// `GROUP BY out` scan over `invoked` yields every counter at once
// (~1-2s vs ~150s+).
//
// `last_used` is computed in a second per-skill query because tracking a
// max(ts) inside the GROUP BY is awkward and adds cost; the per-skill
// `ORDER BY ts DESC LIMIT 1` is cheap (one btree seek per skill).
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
        skill_id.name AS name,
        skill_id.scope AS scope,
        skill_id.description AS description,
        skill_id.dir_path AS dir_path,
        skill_id.bytes AS bytes,
        total_inv,
        inv_7d,
        inv_30d,
        corrections,
        array::len(skill_id<-proposed) AS proposals,
        array::distinct(skill_id<-invoked.in.session ?? []) AS skill_sessions,
        (SELECT ts FROM invoked WHERE out = $parent.skill_id ORDER BY ts DESC LIMIT 1)[0].ts AS last_used
    FROM (
        SELECT
            out AS skill_id,
            count() AS total_inv,
            math::sum(IF ts > time::now() - 7d  THEN 1 ELSE 0 END) AS inv_7d,
            math::sum(IF ts > time::now() - 30d THEN 1 ELSE 0 END) AS inv_30d,
            math::sum(IF was_corrected = true THEN 1 ELSE 0 END) AS corrections
        FROM invoked
        GROUP BY out
    )
    WHERE skill_id.name IS NOT NONE
)
ORDER BY taste_score DESC, inv_30d DESC, total_inv DESC
LIMIT 500;`;

/**
 * Skills with `proposed` edges but no `invoked` edges. The
 * `SKILL_SUMMARY_SQL` GROUP BY scan can't see them (it iterates the
 * `invoked` table), so we union them in client-side. Cheap query: scope
 * is the ~hundred-skill metadata table, no per-row record fetch.
 */
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
    0 AS corrections,
    array::len(<-proposed) AS proposals,
    0 AS commits_after,
    -0.5 * array::len(<-proposed) AS taste_score
FROM skill
WHERE array::len(<-invoked) = 0 AND array::len(<-proposed) > 0;`;

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
