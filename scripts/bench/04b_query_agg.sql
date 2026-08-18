-- Aggregation / cost-rollup shape: tool_call counts grouped through a session join by model.
-- (our real-scale export has no per-row cost column on tool_call -- that lives in
-- session_token_usage, out of scope for this fixture -- so this proxies the
-- "aggregate scan + join + group by" shape, not literal cost arithmetic.)
.timer on
SELECT s.model, count(*) AS n_tool_calls, count(DISTINCT t.session) AS n_sessions
FROM tool_call t
JOIN session s ON t.session = s.id
GROUP BY s.model
ORDER BY n_tool_calls DESC;
