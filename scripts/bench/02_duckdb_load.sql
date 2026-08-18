-- ax v2.1 DuckDB bench: bulk load real-scale export into DuckDB tables.
-- Proxies the "re-derive write path minus parse" - JSONL is already parsed;
-- this measures table create + JSON ingest + basic typing only.
.timer on

CREATE OR REPLACE TABLE turn (
  id VARCHAR,
  session VARCHAR,
  ts TIMESTAMP,
  role VARCHAR,
  text_excerpt VARCHAR
);
COPY turn FROM 'jsonl/turn.jsonl' (FORMAT json);

CREATE OR REPLACE TABLE tool_call (
  id VARCHAR,
  session VARCHAR,
  ts TIMESTAMP,
  name VARCHAR,
  status VARCHAR
);
COPY tool_call FROM 'jsonl/tool_call.jsonl' (FORMAT json);

CREATE OR REPLACE TABLE session (
  id VARCHAR,
  source VARCHAR,
  project VARCHAR,
  model VARCHAR,
  started_at TIMESTAMP,
  ended_at TIMESTAMP
);
COPY session FROM 'jsonl/session.jsonl' (FORMAT json);

CREATE OR REPLACE TABLE "commit" (
  id VARCHAR,
  sha VARCHAR,
  message VARCHAR,
  ts TIMESTAMP,
  repo VARCHAR
);
COPY "commit" FROM 'jsonl/commit.jsonl' (FORMAT json);

-- graph-traversal tables: skill catalog + two edge tables (invoked, spawned)
CREATE OR REPLACE TABLE skill (
  id VARCHAR,
  name VARCHAR,
  dir_path VARCHAR,
  scope VARCHAR
);
COPY skill FROM 'jsonl/skill.jsonl' (FORMAT json);

-- Edge tables use the SAME in_id/out_id column names + index shapes as
-- production (packages/schema/src/schema.duckdb.sql). The bench previously used
-- invented names (turn_id/skill_id/parent_session/child_session/session_id/
-- otel_id), so its graph queries never exercised the real edge column names or
-- indexes - a gate could pass while a production edge join failed (wave-0
-- finding P1/P2). Keep the bench's mini-fixture row counts; only the shapes
-- track production now.
CREATE OR REPLACE TABLE invoked (
  in_id VARCHAR,   -- ref -> turn
  out_id VARCHAR,  -- ref -> skill
  session VARCHAR,
  ts TIMESTAMP
);
COPY invoked FROM 'jsonl/invoked.jsonl' (FORMAT json);
CREATE INDEX invoked_out_ts ON invoked(out_id, ts);
CREATE INDEX invoked_session_out_ts ON invoked(session, out_id, ts);
CREATE INDEX invoked_in ON invoked(in_id);
CREATE INDEX invoked_out ON invoked(out_id);

CREATE OR REPLACE TABLE spawned (
  in_id VARCHAR,   -- ref -> session (parent)
  out_id VARCHAR,  -- ref -> session (child)
  ts TIMESTAMP,
  agent_type VARCHAR,
  description VARCHAR
);
COPY spawned FROM 'jsonl/spawned.jsonl' (FORMAT json);
CREATE INDEX spawned_in ON spawned(in_id);
CREATE INDEX spawned_out ON spawned(out_id);

CREATE OR REPLACE TABLE telemetry_of (
  in_id VARCHAR,
  out_id VARCHAR,
  out_table VARCHAR,
  linked_at TIMESTAMP
);
COPY telemetry_of FROM 'jsonl/telemetry_of.jsonl' (FORMAT json);
CREATE INDEX telemetry_of_in ON telemetry_of(in_id);
CREATE INDEX telemetry_of_out ON telemetry_of(out_id);

SELECT 'turn' AS tbl, count(*) FROM turn
UNION ALL SELECT 'tool_call', count(*) FROM tool_call
UNION ALL SELECT 'session', count(*) FROM session
UNION ALL SELECT 'commit', count(*) FROM "commit"
UNION ALL SELECT 'skill', count(*) FROM skill
UNION ALL SELECT 'invoked', count(*) FROM invoked
UNION ALL SELECT 'spawned', count(*) FROM spawned
UNION ALL SELECT 'telemetry_of', count(*) FROM telemetry_of;
