/**
 * Per-skill detail payload powering the TUI DetailPane (incl. the 30-day
 * `daily` sparkline buckets), the web dashboard's "click recommendation
 * reason → see evidence" expand panel, and `GET /api/skills/:name/detail`.
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
        SELECT ts, in.session.project AS project, turn_has_error
        FROM invoked
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 10
    ),
    daily: (
        SELECT ts FROM invoked
        WHERE out = $s.id AND ts > time::now() - 30d
        ORDER BY ts ASC
    ),
    corrections: (
        SELECT ts, in.session.project AS project
        FROM invoked
        WHERE out = $s.id AND was_corrected = true
        ORDER BY ts DESC
        LIMIT 5
    ),
    proposals: (
        -- Some legacy proposed edges have ts = epoch (ingest path used to skip
        -- the field). Fall back to the source turn's ts so the timeline reads
        -- correctly.
        SELECT
            (IF ts > d"1970-01-02" THEN ts ELSE in.ts END) AS ts,
            in.session.project AS project,
            context_excerpt
        FROM proposed
        WHERE out = $s.id
        ORDER BY ts DESC
        LIMIT 5
    ),
    paired: (
        -- Skills that co-occurred in the same session within a turn window
        -- (denormalised by derive-signals). The pair is undirected, so we
        -- check both directions and surface the partner's name.
        -- Some legacy edges have last_seen = epoch; null those out so the
        -- UI can show "-" instead of 1970.
        SELECT
            (IF in = $s.id THEN out.name ELSE in.name END) AS partner,
            count,
            (IF last_seen > d"1970-01-02" THEN last_seen ELSE NONE END) AS last_seen
        FROM skill_paired
        WHERE in = $s.id OR out = $s.id
        ORDER BY count DESC
        LIMIT 5
    )
};`;
