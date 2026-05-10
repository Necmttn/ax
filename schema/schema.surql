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

-- Full-text search (BM25 + ngram tokenization) for `agentctl search`.
-- ngram(2, 8) generates 2-8 char substrings so partial-word queries hit
-- ("test" matches "test-driven") and multi-word queries rank by combined
-- term presence. SurrealDB v3 FTS indexes are single-field; we score
-- name + description separately and combine in the query
-- (see src/cli/index.ts `cmdSearch`).
DEFINE ANALYZER IF NOT EXISTS skill_text
    TOKENIZERS class
    FILTERS lowercase, ngram(2, 8);
DEFINE INDEX IF NOT EXISTS skill_search_name
    ON skill FIELDS name
    FULLTEXT ANALYZER skill_text BM25 HIGHLIGHTS;
DEFINE INDEX IF NOT EXISTS skill_search_desc
    ON skill FIELDS description
    FULLTEXT ANALYZER skill_text BM25 HIGHLIGHTS;

DEFINE TABLE session SCHEMAFULL;
DEFINE FIELD project        ON session TYPE option<string>;
DEFINE FIELD cwd            ON session TYPE option<string>;
DEFINE FIELD model          ON session TYPE option<string>;
DEFINE FIELD source         ON session TYPE string DEFAULT 'claude';  -- 'claude' | 'codex'
DEFINE FIELD started_at     ON session TYPE option<datetime>;
DEFINE FIELD ended_at       ON session TYPE option<datetime>;
DEFINE FIELD raw_file       ON session TYPE option<string>;  -- f"transcripts:/<id>.jsonl" pointer; full original jsonl
DEFINE FIELD repository     ON session TYPE option<record<repository>>;
DEFINE FIELD checkout       ON session TYPE option<record<checkout>>;
DEFINE FIELD workspace      ON session TYPE option<record<workspace>>;
DEFINE INDEX session_repository_started ON session FIELDS repository, started_at;
DEFINE INDEX session_checkout_started ON session FIELDS checkout, started_at;
DEFINE INDEX session_workspace_started ON session FIELDS workspace, started_at;

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
DEFINE FIELD repository     ON file TYPE option<record<repository>>;
DEFINE FIELD checkout       ON file TYPE option<record<checkout>>;
DEFINE FIELD workspace      ON file TYPE option<record<workspace>>;
DEFINE FIELD kind           ON file TYPE option<string>;
DEFINE FIELD identity_scope ON file TYPE option<string>;
DEFINE INDEX file_path_uq   ON file FIELDS repo, path UNIQUE;
DEFINE INDEX file_repository_path ON file FIELDS repository, path;
REMOVE INDEX IF EXISTS file_checkout_path ON file;
DEFINE INDEX file_workspace_path ON file FIELDS workspace, path;

DEFINE TABLE commit SCHEMAFULL;
DEFINE FIELD sha            ON commit TYPE string;
DEFINE FIELD repo           ON commit TYPE string;
DEFINE FIELD message        ON commit TYPE option<string>;
DEFINE FIELD author         ON commit TYPE option<string>;
DEFINE FIELD ts             ON commit TYPE datetime;
DEFINE FIELD repository     ON commit TYPE option<record<repository>>;
DEFINE FIELD checkout       ON commit TYPE option<record<checkout>>;
DEFINE INDEX commit_sha_uq  ON commit FIELDS repo, sha UNIQUE;
DEFINE INDEX commit_repository_ts ON commit FIELDS repository, ts;
REMOVE INDEX IF EXISTS commit_checkout_ts ON commit;

DEFINE TABLE repository SCHEMAFULL;
DEFINE FIELD name           ON repository TYPE option<string>;
DEFINE FIELD remote_url     ON repository TYPE option<string>;
DEFINE FIELD root_path      ON repository TYPE option<string>;
DEFINE FIELD initial_commit ON repository TYPE option<string>;
DEFINE FIELD default_branch ON repository TYPE option<string>;
DEFINE FIELD created_at     ON repository TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON repository TYPE option<datetime>;
DEFINE INDEX repository_remote ON repository FIELDS remote_url;
DEFINE INDEX repository_initial_commit ON repository FIELDS initial_commit;

DEFINE TABLE checkout SCHEMAFULL;
DEFINE FIELD repository     ON checkout TYPE record<repository>;
DEFINE FIELD path           ON checkout TYPE string;
DEFINE FIELD branch         ON checkout TYPE option<string>;
DEFINE FIELD head_sha       ON checkout TYPE option<string>;
DEFINE FIELD worktree_name  ON checkout TYPE option<string>;
DEFINE FIELD dirty          ON checkout TYPE bool DEFAULT false;
DEFINE FIELD created_at     ON checkout TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON checkout TYPE option<datetime>;
DEFINE INDEX checkout_path_uq ON checkout FIELDS repository, path UNIQUE;

DEFINE TABLE workspace SCHEMAFULL;
DEFINE FIELD repository     ON workspace TYPE option<record<repository>>;
DEFINE FIELD checkout       ON workspace TYPE option<record<checkout>>;
DEFINE FIELD root_path      ON workspace TYPE string;
DEFINE FIELD name           ON workspace TYPE option<string>;
DEFINE FIELD created_at     ON workspace TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON workspace TYPE option<datetime>;

DEFINE TABLE changeset SCHEMAFULL;
DEFINE FIELD session        ON changeset TYPE option<record<session>>;
DEFINE FIELD repository     ON changeset TYPE option<record<repository>>;
DEFINE FIELD checkout       ON changeset TYPE option<record<checkout>>;
DEFINE FIELD summary_text   ON changeset TYPE string;
DEFINE FIELD detail_text    ON changeset TYPE option<string>;
DEFINE FIELD status         ON changeset TYPE option<string>;
DEFINE FIELD labels         ON changeset TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics        ON changeset TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON changeset TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON changeset TYPE option<datetime>;
DEFINE INDEX changeset_session ON changeset FIELDS session, created_at;
DEFINE INDEX changeset_repository ON changeset FIELDS repository, created_at;
DEFINE INDEX changeset_checkout ON changeset FIELDS checkout, created_at;
DEFINE INDEX IF NOT EXISTS changeset_summary_search
    ON changeset FIELDS summary_text
    FULLTEXT ANALYZER skill_text BM25 HIGHLIGHTS;

DEFINE TABLE file_memory SCHEMAFULL;
DEFINE FIELD file           ON file_memory TYPE option<record<file>>;
DEFINE FIELD repository     ON file_memory TYPE option<record<repository>>;
DEFINE FIELD checkout       ON file_memory TYPE option<record<checkout>>;
DEFINE FIELD workspace      ON file_memory TYPE option<record<workspace>>;
DEFINE FIELD path           ON file_memory TYPE option<string>;
DEFINE FIELD kind           ON file_memory TYPE option<string>;
DEFINE FIELD text           ON file_memory TYPE string;
DEFINE FIELD labels         ON file_memory TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics        ON file_memory TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON file_memory TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON file_memory TYPE option<datetime>;
DEFINE INDEX file_memory_file ON file_memory FIELDS file, kind;
DEFINE INDEX file_memory_repository_path ON file_memory FIELDS repository, path;
DEFINE INDEX file_memory_checkout_path ON file_memory FIELDS checkout, path;
DEFINE INDEX file_memory_workspace_path ON file_memory FIELDS workspace, path;
DEFINE INDEX IF NOT EXISTS file_memory_text_search
    ON file_memory FIELDS text
    FULLTEXT ANALYZER skill_text BM25 HIGHLIGHTS;

DEFINE TABLE tool SCHEMAFULL;
DEFINE FIELD name           ON tool TYPE string;
DEFINE FIELD provider       ON tool TYPE option<string>;
DEFINE FIELD identity       ON tool TYPE option<string>;
DEFINE FIELD kind           ON tool TYPE option<string>;
DEFINE FIELD labels         ON tool TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON tool TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON tool TYPE option<datetime>;
DEFINE INDEX tool_identity_uq ON tool FIELDS provider, name, identity UNIQUE;

DEFINE TABLE tool_call SCHEMAFULL;
DEFINE FIELD session        ON tool_call TYPE record<session>;
DEFINE FIELD turn           ON tool_call TYPE option<record<turn>>;
DEFINE FIELD tool           ON tool_call TYPE option<record<tool>>;
DEFINE FIELD name           ON tool_call TYPE string;
DEFINE FIELD ts             ON tool_call TYPE datetime;
DEFINE FIELD status         ON tool_call TYPE option<string>;
DEFINE FIELD input_json     ON tool_call TYPE option<string>;  -- JSON-encoded
DEFINE FIELD output_json    ON tool_call TYPE option<string>;  -- JSON-encoded
DEFINE FIELD raw            ON tool_call TYPE option<string>;  -- JSON-encoded
DEFINE FIELD duration_ms    ON tool_call TYPE option<int>;
DEFINE FIELD seq            ON tool_call TYPE option<int>;
DEFINE FIELD call_id        ON tool_call TYPE option<string>;
DEFINE FIELD cwd            ON tool_call TYPE option<string>;
DEFINE FIELD command_text   ON tool_call TYPE option<string>;
DEFINE FIELD command_norm   ON tool_call TYPE option<string>;
DEFINE FIELD command_tool   ON tool_call TYPE option<record<tool>>;
DEFINE FIELD output_excerpt ON tool_call TYPE option<string>;
DEFINE FIELD error_text     ON tool_call TYPE option<string>;
DEFINE FIELD exit_code      ON tool_call TYPE option<int>;
DEFINE FIELD has_error      ON tool_call TYPE bool DEFAULT false;
DEFINE INDEX tool_call_session_ts ON tool_call FIELDS session, ts;
DEFINE INDEX tool_call_tool_ts ON tool_call FIELDS tool, ts;
DEFINE INDEX tool_call_command_norm_ts ON tool_call FIELDS command_norm, ts;
DEFINE INDEX tool_call_command_tool_ts ON tool_call FIELDS command_tool, ts;
DEFINE INDEX tool_call_error_ts ON tool_call FIELDS has_error, ts;

DEFINE TABLE plan SCHEMAFULL;
DEFINE FIELD session        ON plan TYPE option<record<session>>;
DEFINE FIELD source         ON plan TYPE option<string>;
DEFINE FIELD title          ON plan TYPE option<string>;
DEFINE FIELD summary        ON plan TYPE option<string>;
DEFINE FIELD status         ON plan TYPE option<string>;
DEFINE FIELD items          ON plan TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON plan TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON plan TYPE option<datetime>;
DEFINE INDEX plan_session   ON plan FIELDS session;
DEFINE INDEX plan_source_session ON plan FIELDS source, session;

DEFINE TABLE plan_item SCHEMAFULL;
DEFINE FIELD plan           ON plan_item TYPE record<plan>;
DEFINE FIELD external_id    ON plan_item TYPE option<string>;
DEFINE FIELD seq            ON plan_item TYPE int;
DEFINE FIELD text           ON plan_item TYPE string;
DEFINE FIELD active_form    ON plan_item TYPE option<string>;
DEFINE FIELD status         ON plan_item TYPE option<string>;
DEFINE FIELD raw            ON plan_item TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON plan_item TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON plan_item TYPE option<datetime>;
DEFINE FIELD first_seen_at  ON plan_item TYPE option<datetime>;
DEFINE FIELD last_seen_at   ON plan_item TYPE option<datetime>;
DEFINE INDEX plan_item_plan_seq ON plan_item FIELDS plan, seq UNIQUE;

DEFINE TABLE artifact SCHEMAFULL;
DEFINE FIELD kind           ON artifact TYPE string;
DEFINE FIELD title          ON artifact TYPE option<string>;
DEFINE FIELD uri            ON artifact TYPE option<string>;
DEFINE FIELD path           ON artifact TYPE option<string>;
DEFINE FIELD content_hash   ON artifact TYPE option<string>;
DEFINE FIELD raw            ON artifact TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON artifact TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON artifact TYPE option<datetime>;
DEFINE INDEX artifact_hash  ON artifact FIELDS content_hash;

DEFINE TABLE plan_snapshot SCHEMAFULL;
DEFINE FIELD plan           ON plan_snapshot TYPE option<record<plan>>;
DEFINE FIELD session        ON plan_snapshot TYPE option<record<session>>;
DEFINE FIELD tool_call      ON plan_snapshot TYPE option<record<tool_call>>;
DEFINE FIELD source         ON plan_snapshot TYPE option<string>;
DEFINE FIELD items          ON plan_snapshot TYPE string;  -- JSON-encoded
DEFINE FIELD summary        ON plan_snapshot TYPE option<string>;
DEFINE FIELD explanation    ON plan_snapshot TYPE option<string>;
DEFINE FIELD ts             ON plan_snapshot TYPE datetime DEFAULT time::now();
DEFINE INDEX plan_snapshot_plan_ts ON plan_snapshot FIELDS plan, ts;

DEFINE TABLE insight SCHEMAFULL;
DEFINE FIELD subject_type   ON insight TYPE string;
DEFINE FIELD subject_id     ON insight TYPE option<string>;
DEFINE FIELD kind           ON insight TYPE option<string>;
DEFINE FIELD text           ON insight TYPE string;
DEFINE FIELD labels         ON insight TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics        ON insight TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON insight TYPE datetime DEFAULT time::now();
DEFINE INDEX insight_subject ON insight FIELDS subject_type, subject_id;

DEFINE TABLE friction_event SCHEMAFULL;
DEFINE FIELD session        ON friction_event TYPE option<record<session>>;
DEFINE FIELD turn           ON friction_event TYPE option<record<turn>>;
DEFINE FIELD kind           ON friction_event TYPE string;
DEFINE FIELD text           ON friction_event TYPE option<string>;
DEFINE FIELD labels         ON friction_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics        ON friction_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD raw            ON friction_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts             ON friction_event TYPE datetime DEFAULT time::now();
DEFINE INDEX friction_session_kind ON friction_event FIELDS session, kind;

DEFINE TABLE feedback_event SCHEMAFULL;
DEFINE FIELD session        ON feedback_event TYPE option<record<session>>;
DEFINE FIELD turn           ON feedback_event TYPE option<record<turn>>;
DEFINE FIELD kind           ON feedback_event TYPE string;
DEFINE FIELD sentiment      ON feedback_event TYPE option<string>;
DEFINE FIELD text           ON feedback_event TYPE option<string>;
DEFINE FIELD labels         ON feedback_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics        ON feedback_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD raw            ON feedback_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts             ON feedback_event TYPE datetime DEFAULT time::now();
DEFINE INDEX feedback_session_kind ON feedback_event FIELDS session, kind;

DEFINE TABLE diagnostic_event SCHEMAFULL;
DEFINE FIELD session        ON diagnostic_event TYPE option<record<session>>;
DEFINE FIELD turn           ON diagnostic_event TYPE option<record<turn>>;
DEFINE FIELD kind           ON diagnostic_event TYPE string;
DEFINE FIELD status         ON diagnostic_event TYPE option<string>;
DEFINE FIELD text           ON diagnostic_event TYPE option<string>;
DEFINE FIELD labels         ON diagnostic_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics        ON diagnostic_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD raw            ON diagnostic_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts             ON diagnostic_event TYPE datetime DEFAULT time::now();
DEFINE INDEX diagnostic_session_kind ON diagnostic_event FIELDS session, kind;

DEFINE TABLE recommendation SCHEMAFULL;
DEFINE FIELD subject_type   ON recommendation TYPE option<string>;
DEFINE FIELD subject_id     ON recommendation TYPE option<string>;
DEFINE FIELD status         ON recommendation TYPE string DEFAULT 'open';
DEFINE FIELD text           ON recommendation TYPE string;
DEFINE FIELD rationale      ON recommendation TYPE option<string>;
DEFINE FIELD labels         ON recommendation TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics        ON recommendation TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON recommendation TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON recommendation TYPE option<datetime>;
DEFINE INDEX recommendation_status ON recommendation FIELDS status;
DEFINE INDEX recommendation_subject ON recommendation FIELDS subject_type, subject_id;

DEFINE TABLE guidance SCHEMAFULL;
DEFINE FIELD slug           ON guidance TYPE string;
DEFINE FIELD title          ON guidance TYPE option<string>;
DEFINE FIELD status         ON guidance TYPE string DEFAULT 'active';
DEFINE FIELD labels         ON guidance TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON guidance TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON guidance TYPE option<datetime>;
DEFINE INDEX guidance_slug_uq ON guidance FIELDS slug UNIQUE;
DEFINE INDEX guidance_status ON guidance FIELDS status;

DEFINE TABLE guidance_version SCHEMAFULL;
DEFINE FIELD guidance       ON guidance_version TYPE record<guidance>;
DEFINE FIELD version        ON guidance_version TYPE string;
DEFINE FIELD text           ON guidance_version TYPE string;
DEFINE FIELD raw            ON guidance_version TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON guidance_version TYPE datetime DEFAULT time::now();
DEFINE INDEX guidance_version_uq ON guidance_version FIELDS guidance, version UNIQUE;

-- ==== Ingest telemetry tables ====

DEFINE TABLE ingest_run SCHEMAFULL;
DEFINE FIELD command       ON ingest_run TYPE string;
DEFINE FIELD status        ON ingest_run TYPE string DEFAULT 'running';
DEFINE FIELD since_days    ON ingest_run TYPE option<int>;
DEFINE FIELD started_at    ON ingest_run TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at      ON ingest_run TYPE option<datetime>;
DEFINE FIELD metrics       ON ingest_run TYPE option<string>;
DEFINE INDEX ingest_run_status_started ON ingest_run FIELDS status, started_at;

DEFINE TABLE ingest_stage SCHEMAFULL;
DEFINE FIELD run           ON ingest_stage TYPE record<ingest_run>;
DEFINE FIELD source        ON ingest_stage TYPE string;
DEFINE FIELD stage         ON ingest_stage TYPE string;
DEFINE FIELD status        ON ingest_stage TYPE string DEFAULT 'running';
DEFINE FIELD started_at    ON ingest_stage TYPE datetime DEFAULT time::now();
DEFINE FIELD ended_at      ON ingest_stage TYPE option<datetime>;
DEFINE FIELD counts        ON ingest_stage TYPE option<string>;
DEFINE FIELD error_text    ON ingest_stage TYPE option<string>;
DEFINE INDEX ingest_stage_run ON ingest_stage FIELDS run, started_at;

DEFINE TABLE ingest_event SCHEMAFULL;
DEFINE FIELD run           ON ingest_event TYPE record<ingest_run>;
DEFINE FIELD source        ON ingest_event TYPE string;
DEFINE FIELD stage         ON ingest_event TYPE string;
DEFINE FIELD level         ON ingest_event TYPE string;
DEFINE FIELD message       ON ingest_event TYPE string;
DEFINE FIELD counts        ON ingest_event TYPE option<string>;
DEFINE FIELD raw           ON ingest_event TYPE option<string>;
DEFINE FIELD ts            ON ingest_event TYPE datetime DEFAULT time::now();
DEFINE INDEX ingest_event_run_ts ON ingest_event FIELDS run, ts;
DEFINE INDEX ingest_event_source_ts ON ingest_event FIELDS source, ts;

DEFINE TABLE query_sample SCHEMAFULL;
DEFINE FIELD name          ON query_sample TYPE option<string>;
DEFINE FIELD sql           ON query_sample TYPE string;
DEFINE FIELD status        ON query_sample TYPE string;
DEFINE FIELD duration_ms   ON query_sample TYPE option<int>;
DEFINE FIELD error_text    ON query_sample TYPE option<string>;
DEFINE FIELD row_count     ON query_sample TYPE option<int>;
DEFINE FIELD created_at    ON query_sample TYPE datetime DEFAULT time::now();

DEFINE TABLE graph_health_check SCHEMAFULL;
DEFINE FIELD kind          ON graph_health_check TYPE string;
DEFINE FIELD status        ON graph_health_check TYPE string;
DEFINE FIELD count         ON graph_health_check TYPE int DEFAULT 0;
DEFINE FIELD rows          ON graph_health_check TYPE option<string>;
DEFINE FIELD created_at    ON graph_health_check TYPE datetime DEFAULT time::now();
DEFINE INDEX graph_health_kind_created ON graph_health_check FIELDS kind, created_at;

-- ==== Relations (taste graph) ====

DEFINE TABLE invoked      TYPE RELATION FROM turn TO skill;     -- explicit Skill tool call
DEFINE FIELD args         ON invoked TYPE option<string>;       -- JSON-encoded
DEFINE FIELD ts           ON invoked TYPE datetime;
-- Denormalised copies of the source turn's `has_error` and "was corrected
-- within 3 user turns" flags. cmdTaste's `clean_inv` / `corrections`
-- subqueries previously dereferenced `in.has_error` / walked `corrected_by`
-- per row, which forced a per-edge record fetch (~1-2s on the largest skill
-- × 137 skills). With these flags on the edge, the same counts collapse to a
-- single full-scan GROUP BY out aggregate (see issue #31). Default `false`
-- so freshly-relate'd edges never carry NONE (which would break the
-- `WHERE turn_has_error = false` predicate). Populated at ingest
-- (transcripts.ts, codex.ts) and updated by derive-signals when a
-- corrected_by edge is emitted.
DEFINE FIELD turn_has_error ON invoked TYPE bool DEFAULT false;
DEFINE FIELD was_corrected  ON invoked TYPE bool DEFAULT false;
-- Most cmdTaste/cmdSearch/cmdUnused subqueries filter
-- `WHERE out = $skill_id AND ts > time::now() - Nd`. Composite index
-- covers both predicates from one seek.
DEFINE INDEX IF NOT EXISTS invoked_out_ts ON invoked FIELDS out, ts;

DEFINE TABLE proposed     TYPE RELATION FROM turn TO skill;     -- assistant text mentioned skill, never invoked
DEFINE FIELD ts           ON proposed TYPE datetime;
DEFINE FIELD context_excerpt ON proposed TYPE option<string>;
-- `<-proposed` traversal counts (proposed-but-never-invoked) hit `out`.
DEFINE INDEX IF NOT EXISTS proposed_out ON proposed FIELDS out;

DEFINE TABLE edited       TYPE RELATION FROM turn TO file;      -- Edit/Write tool fired
DEFINE FIELD tool         ON edited TYPE string;                -- 'Edit'|'Write'|'NotebookEdit'
DEFINE FIELD ts           ON edited TYPE datetime;
DEFINE FIELD checkout     ON edited TYPE option<record<checkout>>;
DEFINE FIELD path_seen    ON edited TYPE option<string>;
DEFINE FIELD absolute_path_seen ON edited TYPE option<string>;
DEFINE FIELD edit_kind    ON edited TYPE option<string>;
-- `edited` lookups by source turn (e.g., 'which files did this session edit').
DEFINE INDEX IF NOT EXISTS edited_in ON edited FIELDS in;

DEFINE TABLE corrected_by TYPE RELATION FROM turn TO turn;      -- assistant turn → next user turn that pushed back
DEFINE FIELD pattern      ON corrected_by TYPE option<string>;  -- which negation pattern matched
DEFINE FIELD ts           ON corrected_by TYPE datetime;
-- `corrected_by` lookups in cmdTaste's correction-rate subquery walk via `in`
-- (the assistant turn that was corrected).
DEFINE INDEX IF NOT EXISTS corrected_by_in ON corrected_by FIELDS in;

DEFINE TABLE produced TYPE RELATION FROM session TO commit;
DEFINE FIELD repository   ON produced TYPE option<record<repository>>;
DEFINE FIELD checkout     ON produced TYPE option<record<checkout>>;
DEFINE FIELD ts           ON produced TYPE option<datetime>;
DEFINE FIELD source       ON produced TYPE option<string>;
DEFINE FIELD kind         ON produced TYPE option<string>;
DEFINE INDEX IF NOT EXISTS produced_in_ts ON produced FIELDS in, ts;
DEFINE INDEX IF NOT EXISTS produced_out_ts ON produced FIELDS out, ts;
DEFINE INDEX IF NOT EXISTS produced_repository_checkout_ts ON produced FIELDS repository, checkout, ts;

DEFINE TABLE touched      TYPE RELATION FROM commit TO file;
DEFINE FIELD additions    ON touched TYPE option<int>;
DEFINE FIELD deletions    ON touched TYPE option<int>;
DEFINE FIELD status       ON touched TYPE option<string>;
DEFINE FIELD old_path     ON touched TYPE option<string>;
DEFINE FIELD new_path     ON touched TYPE option<string>;
DEFINE FIELD repository   ON touched TYPE option<record<repository>>;
DEFINE FIELD checkout     ON touched TYPE option<record<checkout>>;
DEFINE FIELD ts           ON touched TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS touched_in ON touched FIELDS in;
DEFINE INDEX IF NOT EXISTS touched_out ON touched FIELDS out;
DEFINE INDEX IF NOT EXISTS touched_repository_ts ON touched FIELDS repository, ts;
DEFINE INDEX IF NOT EXISTS touched_checkout_ts ON touched FIELDS checkout, ts;
DEFINE INDEX IF NOT EXISTS touched_in_checkout ON touched FIELDS in, checkout;

DEFINE TABLE has_checkout TYPE RELATION FROM repository TO checkout;
DEFINE FIELD ts           ON has_checkout TYPE datetime DEFAULT time::now();

DEFINE TABLE concerns     TYPE RELATION SCHEMAFULL;
DEFINE FIELD kind         ON concerns TYPE option<string>;
DEFINE FIELD weight       ON concerns TYPE option<int>;
DEFINE FIELD reason       ON concerns TYPE option<string>;
DEFINE FIELD labels       ON concerns TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics      ON concerns TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts           ON concerns TYPE datetime DEFAULT time::now();
DEFINE INDEX concerns_in  ON concerns FIELDS in;
DEFINE INDEX concerns_out ON concerns FIELDS out;

DEFINE TABLE includes     TYPE RELATION FROM changeset TO file_memory SCHEMAFULL;
DEFINE FIELD kind         ON includes TYPE option<string>;
DEFINE FIELD labels       ON includes TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts           ON includes TYPE datetime DEFAULT time::now();
DEFINE INDEX includes_in  ON includes FIELDS in;
DEFINE INDEX includes_out ON includes FIELDS out;

DEFINE TABLE involves     TYPE RELATION FROM changeset TO file SCHEMAFULL;
DEFINE FIELD role         ON involves TYPE option<string>;
DEFINE FIELD labels       ON involves TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts           ON involves TYPE datetime DEFAULT time::now();
DEFINE INDEX involves_in  ON involves FIELDS in;
DEFINE INDEX involves_out ON involves FIELDS out;

DEFINE TABLE resulted_in  TYPE RELATION SCHEMAFULL;
DEFINE FIELD kind         ON resulted_in TYPE option<string>;
DEFINE FIELD labels       ON resulted_in TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts           ON resulted_in TYPE datetime DEFAULT time::now();
DEFINE INDEX resulted_in_in ON resulted_in FIELDS in;
DEFINE INDEX resulted_in_out ON resulted_in FIELDS out;

DEFINE TABLE supersedes   TYPE RELATION SCHEMAFULL;
DEFINE FIELD reason       ON supersedes TYPE option<string>;
DEFINE FIELD ts           ON supersedes TYPE datetime DEFAULT time::now();
DEFINE INDEX supersedes_in ON supersedes FIELDS in;
DEFINE INDEX supersedes_out ON supersedes FIELDS out;

DEFINE TABLE produced_artifact TYPE RELATION SCHEMAFULL;
DEFINE FIELD kind         ON produced_artifact TYPE option<string>;
DEFINE FIELD labels       ON produced_artifact TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts           ON produced_artifact TYPE datetime DEFAULT time::now();
DEFINE INDEX produced_artifact_in ON produced_artifact FIELDS in;
DEFINE INDEX produced_artifact_out ON produced_artifact FIELDS out;

DEFINE TABLE has_artifact TYPE RELATION SCHEMAFULL;
DEFINE FIELD kind         ON has_artifact TYPE option<string>;
DEFINE FIELD labels       ON has_artifact TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts           ON has_artifact TYPE datetime DEFAULT time::now();
DEFINE INDEX has_artifact_in ON has_artifact FIELDS in;
DEFINE INDEX has_artifact_out ON has_artifact FIELDS out;

DEFINE TABLE derived_from TYPE RELATION SCHEMAFULL;
DEFINE FIELD kind         ON derived_from TYPE option<string>;
DEFINE FIELD labels       ON derived_from TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts           ON derived_from TYPE datetime DEFAULT time::now();
DEFINE INDEX derived_from_in ON derived_from FIELDS in;
DEFINE INDEX derived_from_out ON derived_from FIELDS out;

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
