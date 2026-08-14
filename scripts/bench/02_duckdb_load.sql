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

CREATE OR REPLACE TABLE invoked (
  turn_id VARCHAR,
  skill_id VARCHAR,
  session VARCHAR,
  ts TIMESTAMP
);
COPY invoked FROM 'jsonl/invoked.jsonl' (FORMAT json);

CREATE OR REPLACE TABLE spawned (
  parent_session VARCHAR,
  child_session VARCHAR,
  ts TIMESTAMP,
  agent_type VARCHAR,
  description VARCHAR
);
COPY spawned FROM 'jsonl/spawned.jsonl' (FORMAT json);

SELECT 'turn' AS tbl, count(*) FROM turn
UNION ALL SELECT 'tool_call', count(*) FROM tool_call
UNION ALL SELECT 'session', count(*) FROM session
UNION ALL SELECT 'commit', count(*) FROM "commit"
UNION ALL SELECT 'skill', count(*) FROM skill
UNION ALL SELECT 'invoked', count(*) FROM invoked
UNION ALL SELECT 'spawned', count(*) FROM spawned;
