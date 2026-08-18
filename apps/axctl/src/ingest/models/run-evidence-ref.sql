-- model: run_evidence_ref
-- inputs: tool_call, read_file, searched_file, edited, turn
-- rebuild: incremental
--
-- File refs off run-evidence tool_observation events (#578 slices 4+5),
-- derived inside DuckDB (#888). Mirrors buildRunEvidenceRefs:
--  * read_file / searched_file (RELATION tool_call -> file) anchor to the
--    tool_call's tool_observation event directly;
--  * edited (RELATION turn -> file) bridges to the turn's edit tool_call ONLY
--    when the turn has exactly ONE edit call - ambiguous multi-edit turns are
--    dropped rather than mis-attributed.
--
-- DELIBERATE DIFFERENCES from the TS builders (rebuildable-cache freedoms,
-- same cutover wipe as run-evidence-event.sql):
--  * event key + ref id are md5 over <US>-separated natural keys;
--  * path_hash = md5(path_seen) (was stableDigest - privacy pointer only,
--    nothing joins on its shape).
--
-- The edit-tool name list below MUST equal EDIT_TOOL_NAMES
-- (@ax/lib/shared/tool-classes) lowercased - pinned by models.test.ts.
INSERT INTO run_evidence_ref (
    id, "event", session, ts, ref_kind, target_table, target_id,
    path_hash, uri_hash, content_hash, privacy_level, attrs
)
WITH
params AS (
    SELECT CASE
        WHEN getvariable('since_days') IS NULL THEN NULL
        ELSE CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(getvariable('since_days') AS INTEGER) * INTERVAL '1 day')
    END AS cutoff
),
-- Turns with exactly ONE edit tool_call: the unambiguous edited-bridge anchor.
single_edit_call AS (
    SELECT tc.turn, min(tc.id) AS tool_call
    FROM tool_call tc, params p
    WHERE tc.turn IS NOT NULL
      AND lower(tc.name) IN ('edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'edit_file', 'apply_diff')
      AND (p.cutoff IS NULL OR tc.ts > p.cutoff)
    GROUP BY tc.turn
    HAVING count(*) = 1
),
src AS (
    -- read_file -> access 'read'
    SELECT tc.session AS session, e.in_id AS tool_call, e.out_id AS file,
           e.ts AS ts, e.path_seen AS path_seen,
           json_object('access', 'read') AS attrs
    FROM read_file e
    JOIN tool_call tc ON tc.id = e.in_id
    CROSS JOIN params p
    WHERE e.ts IS NOT NULL AND (p.cutoff IS NULL OR e.ts > p.cutoff)

    UNION ALL
    -- searched_file -> access 'search'
    SELECT tc.session, e.in_id, e.out_id, e.ts, e.path_seen,
           json_object('access', 'search')
    FROM searched_file e
    JOIN tool_call tc ON tc.id = e.in_id
    CROSS JOIN params p
    WHERE e.ts IS NOT NULL AND (p.cutoff IS NULL OR e.ts > p.cutoff)

    UNION ALL
    -- edited (turn -> file), bridged to the turn's single edit tool_call.
    SELECT t.session, sec.tool_call, e.out_id, e.ts, e.path_seen,
           json_merge_patch(json_merge_patch('{}', json_object('access', 'write')), json_object('tool', e.tool))
    FROM edited e
    JOIN turn t ON t.id = e.in_id
    JOIN single_edit_call sec ON sec.turn = e.in_id
    CROSS JOIN params p
    WHERE e.ts IS NOT NULL AND (p.cutoff IS NULL OR e.ts > p.cutoff)
),
shaped AS (
    SELECT
        md5(session || chr(31) || 'tool_call' || chr(31) || tool_call) AS event_id,
        session, ts,
        'file' AS ref_kind, 'file' AS target_table, file AS target_id,
        CASE WHEN path_seen IS NOT NULL THEN md5(path_seen) END AS path_hash,
        attrs
    FROM src
    WHERE session IS NOT NULL AND tool_call IS NOT NULL AND file IS NOT NULL
)
SELECT
    md5(event_id || chr(31) || ref_kind || chr(31) || target_table || chr(31)
        || target_id || chr(31) || coalesce(path_hash, '')) AS id,
    event_id AS "event", session, ts, ref_kind, target_table, target_id,
    path_hash, NULL AS uri_hash, NULL AS content_hash,
    'ref_only' AS privacy_level, attrs
FROM shaped
-- One ref row per distinct pointer: the same (event, file, path) read twice in
-- a window collapses, keeping the earliest ts (deterministic).
QUALIFY row_number() OVER (
    PARTITION BY event_id, ref_kind, target_table, target_id, coalesce(path_hash, '')
    ORDER BY ts, attrs
) = 1
ON CONFLICT (id) DO UPDATE SET
    "event" = excluded."event", session = excluded.session, ts = excluded.ts,
    ref_kind = excluded.ref_kind, target_table = excluded.target_table,
    target_id = excluded.target_id, path_hash = excluded.path_hash,
    uri_hash = excluded.uri_hash, content_hash = excluded.content_hash,
    privacy_level = excluded.privacy_level, attrs = excluded.attrs
