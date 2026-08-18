-- Join-heavy drill: turns of one (median-sized, 54-turn) session ordered by ts.
.timer on
SELECT id, ts, role, text_excerpt
FROM turn
WHERE session = 'session:`claude-subagent-af3f3b45c70ccf85c`'
ORDER BY ts;
