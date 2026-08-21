-- model: cache_bust_event
-- inputs: turn_token_usage, cache_bust_event
-- rebuild: incremental
--
-- Remove a derived bust when a reparse clears the source reason. This stays a
-- separate model because the runner permits one statement per model file.
--
-- Window: SET VARIABLE since_days (NULL/unset = full derivation).
-- ICU-less build: the clock MUST be spelled CAST(CURRENT_TIMESTAMP AS TIMESTAMP).
DELETE FROM cache_bust_event AS cbe
USING turn_token_usage AS ttu
WHERE cbe.id = ttu.id
  AND ttu.cache_miss_reason_type IS NULL
  AND (
    getvariable('since_days') IS NULL
    OR ttu.ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(getvariable('since_days') AS INTEGER) * INTERVAL '1 day')
  )
