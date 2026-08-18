-- Graph traversal shape 1: skills invoked in a session, joined to the skill catalog
-- (the "ax skills weighted" / "invoked" edge-join shape).
.timer on
SELECT sk.name, count(*) AS n
FROM invoked i
JOIN skill sk ON i.out_id = sk.id
GROUP BY sk.name
ORDER BY n DESC
LIMIT 20;
