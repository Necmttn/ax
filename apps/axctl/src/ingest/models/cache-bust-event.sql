-- model: cache_bust_event
-- inputs: turn_token_usage
-- rebuild: incremental
--
-- The cache-bust ledger (#868), derived INSIDE DuckDB: one row per usage row
-- whose billing event carried a cache_miss_reason (Claude stamps it since
-- ~2026-05; other providers leave it null, so no source filter is needed -
-- if another harness starts stamping it, its busts appear here for free).
--
-- id == turn_token_usage.id, so the incremental window UPSERTs idempotently
-- and a re-ingested usage row overwrites its bust row in place.
--
-- bust_cost_usd is the ingest pricer's cache-creation estimate. Root-session
-- corroboration belongs in queries/cache-bust.ts, where it compares complete
-- transcript cost with independent OTLP claude_code.cost.usage cost once per
-- root. Storing that root cost on every bust would multiply it by bust count.
--
-- Window: SET VARIABLE since_days (NULL/unset = full derivation).
-- ICU-less build: the clock MUST be spelled CAST(CURRENT_TIMESTAMP AS TIMESTAMP).
INSERT INTO cache_bust_event (
    id, session, turn, seq, source, model, reason,
    attribution_skill, attribution_agent,
    cache_creation_input_tokens, bust_cost_usd, ts
)
SELECT
    ttu.id,
    ttu.session,
    ttu.turn,
    ttu.seq,
    ttu.source,
    ttu.model,
    ttu.cache_miss_reason_type AS reason,
    ttu.attribution_skill,
    ttu.attribution_agent,
    ttu.cache_creation_input_tokens,
    ttu.estimated_cache_creation_cost_usd AS bust_cost_usd,
    ttu.ts
FROM turn_token_usage ttu
WHERE ttu.cache_miss_reason_type IS NOT NULL
  AND (
    getvariable('since_days') IS NULL
    OR ttu.ts >= CAST(CURRENT_TIMESTAMP AS TIMESTAMP) - (CAST(getvariable('since_days') AS INTEGER) * INTERVAL '1 day')
  )
ON CONFLICT (id) DO UPDATE SET
    session = excluded.session,
    turn = excluded.turn,
    seq = excluded.seq,
    source = excluded.source,
    model = excluded.model,
    reason = excluded.reason,
    attribution_skill = excluded.attribution_skill,
    attribution_agent = excluded.attribution_agent,
    cache_creation_input_tokens = excluded.cache_creation_input_tokens,
    bust_cost_usd = excluded.bust_cost_usd,
    ts = excluded.ts
