-- Point lookup / small scan: 50 most recent sessions.
.timer on
SELECT * FROM session ORDER BY started_at DESC LIMIT 50;
