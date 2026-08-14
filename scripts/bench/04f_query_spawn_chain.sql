-- Graph traversal shape 2: subagent dispatch table (the "ax dispatches" shape) --
-- one-hop parent->child session join with a session-attribute lookup.
.timer on
SELECT sp.parent_session, sp.child_session, sp.agent_type, s.model
FROM spawned sp
JOIN session s ON sp.child_session = s.id
ORDER BY sp.ts DESC
LIMIT 30;
