-- Graph traversal shape 2: subagent dispatch table (the "ax dispatches" shape) --
-- one-hop parent->child session join with a session-attribute lookup.
.timer on
SELECT sp.in_id AS parent_session, sp.out_id AS child_session, sp.agent_type, s.model
FROM spawned sp
JOIN session s ON sp.out_id = s.id
ORDER BY sp.ts DESC
LIMIT 30;
