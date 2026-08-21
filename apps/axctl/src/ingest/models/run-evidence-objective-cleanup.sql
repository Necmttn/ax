-- model: run_evidence_event
-- inputs: turn, run_evidence_event
-- rebuild: incremental
--
-- Replace the objective for each session with a task turn in the active
-- window. The event model then selects that session's earliest task turn from
-- all history. This stays separate because one model file has one statement.
--
-- Window: SET VARIABLE since_days (NULL/unset = full derivation).
-- ICU-less build: the clock MUST be spelled CAST(CURRENT_TIMESTAMP AS TIMESTAMP).
DELETE FROM run_evidence_event AS ree
USING (
    SELECT DISTINCT t.session
    FROM turn AS t
    WHERE t.session IS NOT NULL
      AND t.role = 'user'
      AND t.message_kind = 'task'
      AND (
        getvariable('since_days') IS NULL
        OR t.ts > CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(getvariable('since_days') AS INTEGER) * INTERVAL '1 day')
      )
) AS affected
WHERE ree.session = affected.session
  AND ree.kind = 'objective'
