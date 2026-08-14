SELECT out, count() AS n FROM invoked GROUP BY out ORDER BY n DESC LIMIT 20;
