OPTION IMPORT;

-- agentctl schema v0.0.1
-- Graph: skill ← invoked ← turn → edited → file
--                        turn → corrected_by → turn (next-user-turn)
--                        session → produced → commit → touched → file

-- ==== Nodes ====

DEFINE TABLE skill SCHEMAFULL;
DEFINE FIELD name           ON skill TYPE string;
DEFINE FIELD scope          ON skill TYPE string;          -- 'user' | 'project' | 'plugin:<id>' | 'agents-shared'
DEFINE FIELD dir_path       ON skill TYPE string;
DEFINE FIELD description    ON skill TYPE option<string>;   -- parsed from frontmatter; body + raw frontmatter read from dir_path on demand
DEFINE FIELD content_hash   ON skill TYPE string;
DEFINE FIELD bytes          ON skill TYPE option<int>;
DEFINE FIELD ingested_at    ON skill TYPE datetime VALUE time::now();
DEFINE INDEX skill_name_uq  ON skill FIELDS name UNIQUE;
DEFINE INDEX skill_scope    ON skill FIELDS scope;

DEFINE TABLE session SCHEMAFULL;
DEFINE FIELD project        ON session TYPE option<string>;
DEFINE FIELD cwd            ON session TYPE option<string>;
DEFINE FIELD model          ON session TYPE option<string>;
DEFINE FIELD source         ON session TYPE string DEFAULT 'claude';  -- 'claude' | 'codex'
DEFINE FIELD started_at     ON session TYPE option<datetime>;
DEFINE FIELD ended_at       ON session TYPE option<datetime>;
DEFINE FIELD raw_file       ON session TYPE option<string>;  -- f"transcripts:/<id>.jsonl" pointer; full original jsonl

-- ==== File buckets (SurrealDB 3.0 experimental) ====
-- Requires: surreal start --allow-experimental files
--           SURREAL_BUCKET_FOLDER_ALLOWLIST=$AGENTCTL_DATA_DIR/buckets
-- Bucket paths are hardcoded because SurrealQL does not interpolate env vars.
-- apply-schema.sh warns if $AGENTCTL_DATA_DIR differs from the default.

DEFINE BUCKET IF NOT EXISTS transcripts
    BACKEND "file:/Users/necmttn/.local/share/agentctl/buckets/transcripts";
DEFINE BUCKET IF NOT EXISTS codex_artifacts
    BACKEND "file:/Users/necmttn/.local/share/agentctl/buckets/codex_artifacts";

DEFINE TABLE turn SCHEMAFULL;
DEFINE FIELD session        ON turn TYPE record<session>;
DEFINE FIELD seq            ON turn TYPE int;
DEFINE FIELD ts             ON turn TYPE datetime;
DEFINE FIELD role           ON turn TYPE string;          -- 'user' | 'assistant' | 'tool_result'
DEFINE FIELD text_excerpt   ON turn TYPE option<string>;  -- first ~500 chars
DEFINE FIELD has_tool_use   ON turn TYPE bool DEFAULT false;
DEFINE FIELD has_error      ON turn TYPE bool DEFAULT false;
DEFINE INDEX turn_session_seq ON turn FIELDS session, seq UNIQUE;
DEFINE INDEX turn_ts        ON turn FIELDS ts;

DEFINE TABLE file SCHEMAFULL;
DEFINE FIELD repo           ON file TYPE option<string>;
DEFINE FIELD path           ON file TYPE string;
DEFINE FIELD lang           ON file TYPE option<string>;
DEFINE INDEX file_path_uq   ON file FIELDS repo, path UNIQUE;

DEFINE TABLE commit SCHEMAFULL;
DEFINE FIELD sha            ON commit TYPE string;
DEFINE FIELD repo           ON commit TYPE string;
DEFINE FIELD message        ON commit TYPE option<string>;
DEFINE FIELD author         ON commit TYPE option<string>;
DEFINE FIELD ts             ON commit TYPE datetime;
DEFINE INDEX commit_sha_uq  ON commit FIELDS repo, sha UNIQUE;

-- ==== Relations (taste graph) ====

DEFINE TABLE invoked      TYPE RELATION FROM turn TO skill;     -- explicit Skill tool call
DEFINE FIELD args         ON invoked TYPE option<string>;       -- JSON-encoded
DEFINE FIELD ts           ON invoked TYPE datetime;

DEFINE TABLE proposed     TYPE RELATION FROM turn TO skill;     -- assistant text mentioned skill, never invoked
DEFINE FIELD ts           ON proposed TYPE datetime;
DEFINE FIELD context_excerpt ON proposed TYPE option<string>;

DEFINE TABLE edited       TYPE RELATION FROM turn TO file;      -- Edit/Write tool fired
DEFINE FIELD tool         ON edited TYPE string;                -- 'Edit'|'Write'|'NotebookEdit'
DEFINE FIELD ts           ON edited TYPE datetime;

DEFINE TABLE corrected_by TYPE RELATION FROM turn TO turn;      -- assistant turn → next user turn that pushed back
DEFINE FIELD pattern      ON corrected_by TYPE option<string>;  -- which negation pattern matched
DEFINE FIELD ts           ON corrected_by TYPE datetime;

DEFINE TABLE produced     TYPE RELATION FROM session TO commit;
DEFINE TABLE touched      TYPE RELATION FROM commit TO file;
DEFINE FIELD additions    ON touched TYPE option<int>;
DEFINE FIELD deletions    ON touched TYPE option<int>;

DEFINE TABLE skill_paired TYPE RELATION FROM skill TO skill;  -- skills co-occurring in same session within N turns
DEFINE FIELD count        ON skill_paired TYPE int DEFAULT 1;
DEFINE FIELD last_seen    ON skill_paired TYPE datetime;

DEFINE TABLE recovered_by TYPE RELATION FROM turn TO skill;   -- skill invoked after has_error=true turn
DEFINE FIELD ts            ON recovered_by TYPE datetime;
DEFINE FIELD error_excerpt ON recovered_by TYPE option<string>;

-- ==== Materialized views (computed at query time) ====

-- Per-skill counts, recent boost
-- Usage:
--   SELECT name, taste FROM skill ORDER BY taste DESC LIMIT 20;
-- where taste joins counts of (invoked) - (corrected_after_invoked) + commits-after.
-- View intentionally not DEFINE'd here; CLI computes via parameterized SurrealQL
-- to keep this schema migration-cheap.
