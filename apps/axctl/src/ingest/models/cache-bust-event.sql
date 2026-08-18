-- model: cache_bust_event
-- inputs: turn_token_usage, agent_model
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
-- Two prices per bust, deliberately independent:
--  * bust_cost_usd - the ingest pricer's estimated_cache_creation_cost_usd
--    (tiered, fast-multiplier-aware; the number every other cost lens uses).
--  * corroborated_cost_usd - a flat-rate recompute right here
--    (cache_creation_input_tokens x agent_model.cache_creation_per_million_usd,
--    no 200k tier, no fast multiplier). The proposal-minting corroboration
--    guard (plan Q1: agree within ±25% or report-only) reads the two against
--    each other; sharing the ingest pricer would make the guard circular.
--
-- Window: SET VARIABLE since_days (NULL/unset = full derivation).
-- ICU-less build: the clock MUST be spelled CAST(CURRENT_TIMESTAMP AS TIMESTAMP).
INSERT INTO cache_bust_event (
    id, session, turn, seq, source, model, reason,
    attribution_skill, attribution_agent,
    cache_creation_input_tokens, bust_cost_usd, corroborated_cost_usd, ts
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
    CASE
        WHEN ttu.cache_creation_input_tokens IS NOT NULL
         AND am.cache_creation_per_million_usd IS NOT NULL
        THEN ttu.cache_creation_input_tokens * am.cache_creation_per_million_usd / 1000000.0
    END AS corroborated_cost_usd,
    ttu.ts
FROM turn_token_usage ttu
LEFT JOIN agent_model am ON am.id = ttu.model_ref
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
    corroborated_cost_usd = excluded.corroborated_cost_usd,
    ts = excluded.ts
