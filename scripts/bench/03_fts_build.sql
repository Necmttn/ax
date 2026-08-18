-- FTS index build: the cost that runs inside EVERY ingest in the v2.1 design
-- (no incremental updates in DuckDB FTS -- full rebuild each time).
.timer on
PRAGMA create_fts_index('turn', 'id', 'text_excerpt', overwrite=1);
PRAGMA create_fts_index('commit', 'id', 'message', overwrite=1);
