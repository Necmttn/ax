-- Recall shape: BM25 top-20 over turn.text_excerpt, 2-word query.
.timer on
SELECT id, ts, score
FROM (
  SELECT id, ts, fts_main_turn.match_bm25(id, 'ingest pipeline') AS score
  FROM turn
) sq
WHERE score IS NOT NULL
ORDER BY score DESC
LIMIT 20;
