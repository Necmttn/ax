-- Snapshot copy: what runs after every ingest in the v2.1 design --
-- ATTACH both, COPY FROM DATABASE, DETACH. Produces a compacted read-optimized file.
.timer on
ATTACH 'bench.duckdb' AS src (READ_ONLY);
ATTACH 'snapshot.duckdb' AS dst;
COPY FROM DATABASE src TO dst;
DETACH src;
DETACH dst;
