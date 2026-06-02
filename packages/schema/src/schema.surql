OPTION IMPORT;

-- ax schema v0.0.1
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

-- Full-text search (BM25 + ngram tokenization) for `axctl search`.
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
-- Standalone started_at index: the dashboard roots query orders all sessions
-- by started_at with no repository/checkout/workspace prefix, so the composite
-- indexes above don't cover it. See GitHub issue #76.
DEFINE INDEX session_started ON session FIELDS started_at;

DEFINE TABLE agent_provider SCHEMAFULL;
DEFINE FIELD name           ON agent_provider TYPE string;
DEFINE FIELD display_name   ON agent_provider TYPE string;
DEFINE FIELD version        ON agent_provider TYPE option<string>;
DEFINE FIELD capabilities   ON agent_provider TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at     ON agent_provider TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON agent_provider TYPE option<datetime>;
DEFINE INDEX agent_provider_name_uq ON agent_provider FIELDS name UNIQUE;

DEFINE TABLE agent_model SCHEMAFULL;
DEFINE FIELD name                  ON agent_model TYPE string;
DEFINE FIELD provider              ON agent_model TYPE string;
DEFINE FIELD display_name          ON agent_model TYPE string;
DEFINE FIELD input_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD output_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD cache_creation_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD cache_read_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD input_above_200k_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD output_above_200k_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD cache_creation_above_200k_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD cache_read_above_200k_per_million_usd ON agent_model TYPE option<float>;
DEFINE FIELD fast_multiplier     ON agent_model TYPE option<float>;
DEFINE FIELD context_window       ON agent_model TYPE option<int>;
DEFINE FIELD pricing_source        ON agent_model TYPE option<string>;
DEFINE FIELD created_at            ON agent_model TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at            ON agent_model TYPE option<datetime>;
DEFINE INDEX agent_model_name_uq ON agent_model FIELDS name UNIQUE;
DEFINE INDEX agent_model_provider ON agent_model FIELDS provider;

DEFINE TABLE agent_session SCHEMAFULL;
DEFINE FIELD provider            ON agent_session TYPE record<agent_provider>;
DEFINE FIELD provider_session_id ON agent_session TYPE string;
DEFINE FIELD ax_session          ON agent_session TYPE option<record<session>>;
DEFINE FIELD cwd                 ON agent_session TYPE option<string>;
DEFINE FIELD project             ON agent_session TYPE option<string>;
DEFINE FIELD title               ON agent_session TYPE option<string>;
DEFINE FIELD model               ON agent_session TYPE option<string>;
DEFINE FIELD source_path         ON agent_session TYPE option<string>;
DEFINE FIELD raw                 ON agent_session TYPE option<string>;  -- JSON-encoded
DEFINE FIELD labels              ON agent_session TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics             ON agent_session TYPE option<string>;  -- JSON-encoded
DEFINE FIELD started_at          ON agent_session TYPE option<datetime>;
DEFINE FIELD ended_at            ON agent_session TYPE option<datetime>;
DEFINE FIELD created_at          ON agent_session TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at          ON agent_session TYPE option<datetime>;
DEFINE INDEX agent_session_provider_id ON agent_session FIELDS provider, provider_session_id UNIQUE;
DEFINE INDEX agent_session_ax_session ON agent_session FIELDS ax_session;

DEFINE TABLE agent_event SCHEMAFULL;
DEFINE FIELD agent_session      ON agent_event TYPE record<agent_session>;
DEFINE FIELD ax_session         ON agent_event TYPE option<record<session>>;
DEFINE FIELD provider           ON agent_event TYPE record<agent_provider>;
DEFINE FIELD provider_event_id  ON agent_event TYPE option<string>;
DEFINE FIELD parent_provider_event_id ON agent_event TYPE option<string>;
DEFINE FIELD seq                ON agent_event TYPE int;
DEFINE FIELD ts                 ON agent_event TYPE datetime;
DEFINE FIELD type               ON agent_event TYPE string;
DEFINE FIELD role               ON agent_event TYPE option<string>;
DEFINE FIELD text               ON agent_event TYPE option<string>;
DEFINE FIELD text_excerpt       ON agent_event TYPE option<string>;
DEFINE FIELD raw                ON agent_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD labels             ON agent_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics            ON agent_event TYPE option<string>;  -- JSON-encoded
DEFINE INDEX agent_event_session_seq ON agent_event FIELDS agent_session, seq UNIQUE;
DEFINE INDEX agent_event_provider_id ON agent_event FIELDS provider, provider_event_id;
DEFINE INDEX agent_event_session_ts ON agent_event FIELDS agent_session, ts;

-- ==== File buckets (SurrealDB 3.0 experimental) ====
-- Requires: surreal start --allow-experimental files
--           SURREAL_BUCKET_FOLDER_ALLOWLIST=$AX_DATA_DIR/buckets
-- Bucket paths are hardcoded because SurrealQL does not interpolate env vars.
-- apply-schema.sh warns if $AX_DATA_DIR differs from the default.

DEFINE BUCKET IF NOT EXISTS transcripts
    BACKEND "file:/Users/necmttn/.local/share/ax/buckets/transcripts";
DEFINE BUCKET IF NOT EXISTS codex_artifacts
    BACKEND "file:/Users/necmttn/.local/share/ax/buckets/codex_artifacts";

DEFINE TABLE turn SCHEMAFULL;
DEFINE FIELD session        ON turn TYPE record<session> REFERENCE ON DELETE CASCADE;
DEFINE FIELD agent_event    ON turn TYPE option<record<agent_event>>;
DEFINE FIELD seq            ON turn TYPE int;
DEFINE FIELD ts             ON turn TYPE datetime;
DEFINE FIELD role           ON turn TYPE string;          -- 'user' | 'assistant' | 'tool_result'
DEFINE FIELD message_kind   ON turn TYPE option<string>;  -- 'task' | 'context' | 'control' | 'tool_result' | 'system_or_developer' | 'assistant' | 'tool_call'
DEFINE FIELD intent_kind    ON turn TYPE option<string>;  -- 'organic_task' | 'correction' | 'preference' | 'wrapper_instruction' | ...
DEFINE FIELD text           ON turn TYPE option<string>;  -- full extracted message text for analysis
DEFINE FIELD text_excerpt   ON turn TYPE option<string>;  -- first ~500 chars
DEFINE FIELD has_tool_use   ON turn TYPE bool DEFAULT false;
DEFINE FIELD has_error      ON turn TYPE bool DEFAULT false;
DEFINE INDEX turn_session_seq ON turn FIELDS session, seq UNIQUE;
DEFINE INDEX turn_ts        ON turn FIELDS ts;
DEFINE INDEX turn_agent_event ON turn FIELDS agent_event;

-- Recall (cross-session text search). `class` tokenizer + lowercase filter
-- gives word-level matches; ascii folds accents. BM25 ranks hits so common
-- terms like "test" rank below the user's actual context.
DEFINE ANALYZER IF NOT EXISTS turn_text
    TOKENIZERS class
    FILTERS lowercase, ascii;
DEFINE INDEX IF NOT EXISTS turn_text_fts
    ON turn FIELDS text_excerpt
    FULLTEXT ANALYZER turn_text BM25 HIGHLIGHTS;

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
DEFINE INDEX IF NOT EXISTS file_path ON file FIELDS path;
DEFINE INDEX file_repository_path ON file FIELDS repository, path;
REMOVE INDEX IF EXISTS file_checkout_path ON file;
DEFINE INDEX file_workspace_path ON file FIELDS workspace, path;

DEFINE TABLE symbol SCHEMAFULL;
DEFINE FIELD name           ON symbol TYPE string;
DEFINE FIELD kind           ON symbol TYPE option<string>;      -- 'camel' | 'snake' | 'function' | ...
DEFINE FIELD created_at     ON symbol TYPE datetime DEFAULT time::now();
DEFINE INDEX symbol_name_uq ON symbol FIELDS name UNIQUE;

DEFINE TABLE error_signature SCHEMAFULL;
DEFINE FIELD text           ON error_signature TYPE string;
DEFINE FIELD normalized     ON error_signature TYPE string;
DEFINE FIELD created_at     ON error_signature TYPE datetime DEFAULT time::now();
DEFINE INDEX error_signature_norm_uq ON error_signature FIELDS normalized UNIQUE;

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

-- Full-text search on commit messages (BM25 + word tokenization) for `ax recall` / `ax commits search`.
-- Backs friction F4: "recall BM25 covers turns only - not commit messages".
-- Uses `ascii` filter (same as turn_text) for v0 compatibility with SurrealDB 3.0.
-- `snowball(english)` stemming is not verified for SurrealDB 3.0 so ascii is the safe fallback.
-- DEFINE INDEX IF NOT EXISTS re-indexes existing rows automatically on `bun run db:schema`
-- so no separate backfill code path is needed. HIGHLIGHTS enables SEARCH::highlight() in queries.
DEFINE ANALYZER IF NOT EXISTS commit_text
    TOKENIZERS class
    FILTERS lowercase, ascii;
DEFINE INDEX IF NOT EXISTS commit_message_fts
    ON commit FIELDS message
    FULLTEXT ANALYZER commit_text BM25 HIGHLIGHTS;

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
DEFINE FIELD agent_event    ON tool_call TYPE option<record<agent_event>>;
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
DEFINE INDEX tool_call_agent_event ON tool_call FIELDS agent_event;

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

DEFINE TABLE content_document SCHEMAFULL;
DEFINE FIELD source_kind    ON content_document TYPE string;
DEFINE FIELD source_ref     ON content_document TYPE option<string>;
DEFINE FIELD turn           ON content_document TYPE option<record<turn>>;
DEFINE FIELD session        ON content_document TYPE option<record<session>>;
DEFINE FIELD agent_event    ON content_document TYPE option<record<agent_event>>;
DEFINE FIELD skill          ON content_document TYPE option<record<skill>>;
DEFINE FIELD artifact       ON content_document TYPE option<record<artifact>>;
DEFINE FIELD plan_snapshot  ON content_document TYPE option<record<plan_snapshot>>;
DEFINE FIELD path           ON content_document TYPE option<string>;
DEFINE FIELD uri            ON content_document TYPE option<string>;
DEFINE FIELD title          ON content_document TYPE option<string>;
DEFINE FIELD content_hash   ON content_document TYPE string;
DEFINE FIELD parse_fingerprint ON content_document TYPE string;
DEFINE FIELD registry_version ON content_document TYPE string;
DEFINE FIELD parser_id      ON content_document TYPE string;
DEFINE FIELD parser_version ON content_document TYPE string;
DEFINE FIELD classifier_versions ON content_document TYPE option<string>;
DEFINE FIELD blockset_hash  ON content_document TYPE option<string>;
DEFINE FIELD raw_text       ON content_document TYPE option<string>;
DEFINE FIELD raw            ON content_document TYPE option<string>;
DEFINE FIELD labels         ON content_document TYPE option<string>;
DEFINE FIELD metrics        ON content_document TYPE option<string>;
DEFINE FIELD ts             ON content_document TYPE datetime DEFAULT time::now();
DEFINE INDEX content_document_source ON content_document FIELDS source_kind, source_ref;
DEFINE INDEX content_document_hash ON content_document FIELDS content_hash;
DEFINE INDEX content_document_parse ON content_document FIELDS parse_fingerprint;

DEFINE TABLE content_block SCHEMAFULL;
DEFINE FIELD document       ON content_block TYPE record<content_document> REFERENCE ON DELETE CASCADE;
DEFINE FIELD source_kind    ON content_block TYPE string;
DEFINE FIELD kind           ON content_block TYPE string;
DEFINE FIELD seq            ON content_block TYPE int;
DEFINE FIELD parent_seq     ON content_block TYPE option<int>;
DEFINE FIELD role           ON content_block TYPE option<string>;
DEFINE FIELD heading        ON content_block TYPE option<string>;
DEFINE FIELD text           ON content_block TYPE option<string>;
DEFINE FIELD text_excerpt   ON content_block TYPE option<string>;
DEFINE FIELD search_text    ON content_block TYPE option<string>;
DEFINE FIELD block_hash     ON content_block TYPE string;
DEFINE FIELD start_offset   ON content_block TYPE option<int>;
DEFINE FIELD end_offset     ON content_block TYPE option<int>;
DEFINE FIELD confidence     ON content_block TYPE float DEFAULT 1.0;
DEFINE FIELD parser         ON content_block TYPE string;
DEFINE FIELD raw            ON content_block TYPE option<string>;
DEFINE FIELD labels         ON content_block TYPE option<string>;
DEFINE FIELD metrics        ON content_block TYPE option<string>;
DEFINE FIELD ts             ON content_block TYPE datetime DEFAULT time::now();
DEFINE INDEX content_block_document_seq ON content_block FIELDS document, seq UNIQUE;
DEFINE INDEX content_block_kind ON content_block FIELDS kind, ts;
DEFINE INDEX content_block_hash ON content_block FIELDS document, block_hash;

DEFINE ANALYZER IF NOT EXISTS content_text
    TOKENIZERS class
    FILTERS lowercase, ascii;
DEFINE INDEX IF NOT EXISTS content_block_text_fts
    ON content_block FIELDS search_text
    FULLTEXT ANALYZER content_text BM25 HIGHLIGHTS;

DEFINE TABLE content_atom SCHEMAFULL;
DEFINE FIELD block          ON content_atom TYPE record<content_block> REFERENCE ON DELETE CASCADE;
DEFINE FIELD document       ON content_atom TYPE record<content_document>;
DEFINE FIELD source_kind    ON content_atom TYPE string;
DEFINE FIELD session        ON content_atom TYPE option<record<session>>;
DEFINE FIELD agent_session  ON content_atom TYPE option<record<agent_session>>;
DEFINE FIELD repository     ON content_atom TYPE option<record<repository>>;
DEFINE FIELD workspace      ON content_atom TYPE option<record<workspace>>;
DEFINE FIELD artifact_kind  ON content_atom TYPE option<string>;
DEFINE FIELD kind           ON content_atom TYPE string;
DEFINE FIELD value          ON content_atom TYPE string;
DEFINE FIELD normalized     ON content_atom TYPE option<string>;
DEFINE FIELD start_offset   ON content_atom TYPE option<int>;
DEFINE FIELD end_offset     ON content_atom TYPE option<int>;
DEFINE FIELD confidence     ON content_atom TYPE float DEFAULT 1.0;
DEFINE FIELD raw            ON content_atom TYPE option<string>;
DEFINE FIELD ts             ON content_atom TYPE datetime DEFAULT time::now();
DEFINE INDEX content_atom_kind_value ON content_atom FIELDS kind, normalized;
DEFINE INDEX content_atom_block ON content_atom FIELDS block;
DEFINE INDEX content_atom_document_kind ON content_atom FIELDS document, kind;
DEFINE INDEX content_atom_source_kind_value ON content_atom FIELDS source_kind, kind, normalized;
DEFINE INDEX content_atom_session_kind ON content_atom FIELDS session, kind;
DEFINE INDEX content_atom_workspace_kind_value ON content_atom FIELDS workspace, kind, normalized;

DEFINE TABLE mentions_file TYPE RELATION FROM content_atom TO file SCHEMAFULL;
DEFINE FIELD document      ON mentions_file TYPE record<content_document>;
DEFINE FIELD block         ON mentions_file TYPE record<content_block>;
DEFINE FIELD confidence    ON mentions_file TYPE float DEFAULT 1.0;
DEFINE FIELD source_kind   ON mentions_file TYPE string;
DEFINE FIELD workspace     ON mentions_file TYPE option<record<workspace>>;
DEFINE FIELD ts            ON mentions_file TYPE datetime DEFAULT time::now();
DEFINE INDEX mentions_file_in ON mentions_file FIELDS in;
DEFINE INDEX mentions_file_out ON mentions_file FIELDS out;
DEFINE INDEX mentions_file_document ON mentions_file FIELDS document;

DEFINE TABLE mentions_commit TYPE RELATION FROM content_atom TO commit SCHEMAFULL;
DEFINE FIELD document      ON mentions_commit TYPE record<content_document>;
DEFINE FIELD block         ON mentions_commit TYPE record<content_block>;
DEFINE FIELD confidence    ON mentions_commit TYPE float DEFAULT 1.0;
DEFINE FIELD source_kind   ON mentions_commit TYPE string;
DEFINE FIELD workspace     ON mentions_commit TYPE option<record<workspace>>;
DEFINE FIELD ts            ON mentions_commit TYPE datetime DEFAULT time::now();
DEFINE INDEX mentions_commit_in ON mentions_commit FIELDS in;
DEFINE INDEX mentions_commit_out ON mentions_commit FIELDS out;

DEFINE TABLE mentions_artifact TYPE RELATION FROM content_atom TO artifact SCHEMAFULL;
DEFINE FIELD document      ON mentions_artifact TYPE record<content_document>;
DEFINE FIELD block         ON mentions_artifact TYPE record<content_block>;
DEFINE FIELD confidence    ON mentions_artifact TYPE float DEFAULT 1.0;
DEFINE FIELD source_kind   ON mentions_artifact TYPE string;
DEFINE FIELD ts            ON mentions_artifact TYPE datetime DEFAULT time::now();
DEFINE INDEX mentions_artifact_in ON mentions_artifact FIELDS in;
DEFINE INDEX mentions_artifact_out ON mentions_artifact FIELDS out;

DEFINE TABLE plan_snapshot SCHEMAFULL;
DEFINE FIELD plan           ON plan_snapshot TYPE option<record<plan>>;
DEFINE FIELD session        ON plan_snapshot TYPE option<record<session>>;
DEFINE FIELD tool_call      ON plan_snapshot TYPE option<record<tool_call>>;
DEFINE FIELD agent_event    ON plan_snapshot TYPE option<record<agent_event>>;
DEFINE FIELD source         ON plan_snapshot TYPE option<string>;
DEFINE FIELD items          ON plan_snapshot TYPE string;  -- JSON-encoded
DEFINE FIELD summary        ON plan_snapshot TYPE option<string>;
DEFINE FIELD explanation    ON plan_snapshot TYPE option<string>;
DEFINE FIELD ts             ON plan_snapshot TYPE datetime DEFAULT time::now();
DEFINE INDEX plan_snapshot_plan_ts ON plan_snapshot FIELDS plan, ts;
DEFINE INDEX plan_snapshot_agent_event ON plan_snapshot FIELDS agent_event;

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

DEFINE TABLE IF NOT EXISTS turn_analysis SCHEMAFULL;
DEFINE FIELD turn           ON turn_analysis TYPE record<turn> REFERENCE ON DELETE CASCADE;
DEFINE FIELD session        ON turn_analysis TYPE option<record<session>>;
DEFINE FIELD speaker        ON turn_analysis TYPE string;
DEFINE FIELD act            ON turn_analysis TYPE string;
DEFINE FIELD sentiment      ON turn_analysis TYPE string;
DEFINE FIELD polarity       ON turn_analysis TYPE string;
DEFINE FIELD confidence     ON turn_analysis TYPE float;
DEFINE FIELD method         ON turn_analysis TYPE string;
DEFINE FIELD signals        ON turn_analysis TYPE option<string>;  -- JSON-encoded
DEFINE FIELD text           ON turn_analysis TYPE option<string>;
DEFINE FIELD ts             ON turn_analysis TYPE datetime;
DEFINE FIELD updated_at     ON turn_analysis TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS turn_analysis_turn ON turn_analysis FIELDS turn UNIQUE;
DEFINE INDEX IF NOT EXISTS turn_analysis_session_act ON turn_analysis FIELDS session, act;
DEFINE INDEX IF NOT EXISTS turn_analysis_polarity_ts ON turn_analysis FIELDS polarity, ts;

DEFINE TABLE IF NOT EXISTS reaction_event SCHEMAFULL;
DEFINE FIELD user_turn      ON reaction_event TYPE record<turn> REFERENCE ON DELETE CASCADE;
DEFINE FIELD assistant_turn ON reaction_event TYPE option<record<turn>>;
DEFINE FIELD session        ON reaction_event TYPE option<record<session>>;
DEFINE FIELD reaction_type  ON reaction_event TYPE string;
DEFINE FIELD target         ON reaction_event TYPE string;
DEFINE FIELD polarity       ON reaction_event TYPE string;
DEFINE FIELD durability     ON reaction_event TYPE string;
DEFINE FIELD confidence     ON reaction_event TYPE float;
DEFINE FIELD method         ON reaction_event TYPE string;
DEFINE FIELD signals        ON reaction_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD user_text      ON reaction_event TYPE option<string>;
DEFINE FIELD assistant_text ON reaction_event TYPE option<string>;
DEFINE FIELD context_json   ON reaction_event TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts             ON reaction_event TYPE datetime;
DEFINE FIELD updated_at     ON reaction_event TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS reaction_event_user_turn ON reaction_event FIELDS user_turn UNIQUE;
DEFINE INDEX IF NOT EXISTS reaction_event_session_ts ON reaction_event FIELDS session, ts;
DEFINE INDEX IF NOT EXISTS reaction_event_theme ON reaction_event FIELDS reaction_type, target, durability;

DEFINE TABLE IF NOT EXISTS classifier_definition SCHEMAFULL;
DEFINE FIELD classifier_key ON classifier_definition TYPE string;
DEFINE FIELD version        ON classifier_definition TYPE string;
DEFINE FIELD kind           ON classifier_definition TYPE string;
DEFINE FIELD description    ON classifier_definition TYPE string;
DEFINE FIELD input          ON classifier_definition TYPE string;
DEFINE FIELD labels         ON classifier_definition TYPE string;  -- JSON-encoded
DEFINE FIELD targets        ON classifier_definition TYPE string;  -- JSON-encoded
DEFINE FIELD updated_at     ON classifier_definition TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS classifier_definition_key_version ON classifier_definition FIELDS classifier_key, version UNIQUE;

DEFINE TABLE IF NOT EXISTS classifier_run SCHEMAFULL;
DEFINE FIELD started_at      ON classifier_run TYPE datetime;
DEFINE FIELD finished_at     ON classifier_run TYPE option<datetime>;
DEFINE FIELD status          ON classifier_run TYPE string;
DEFINE FIELD classifier_keys ON classifier_run TYPE string;  -- JSON-encoded
DEFINE FIELD since_days      ON classifier_run TYPE option<int>;
DEFINE FIELD window_count    ON classifier_run TYPE int;
DEFINE FIELD result_count    ON classifier_run TYPE int;
DEFINE INDEX IF NOT EXISTS classifier_run_started ON classifier_run FIELDS started_at;

DEFINE TABLE IF NOT EXISTS classifier_result SCHEMAFULL;
DEFINE FIELD classifier_definition ON classifier_result TYPE record<classifier_definition> REFERENCE ON DELETE CASCADE;
DEFINE FIELD classifier_run        ON classifier_result TYPE option<record<classifier_run>>;
DEFINE FIELD classifier_key        ON classifier_result TYPE string;
DEFINE FIELD classifier_version    ON classifier_result TYPE string;
DEFINE FIELD subject_type          ON classifier_result TYPE string;
DEFINE FIELD subject_id            ON classifier_result TYPE string;
DEFINE FIELD session               ON classifier_result TYPE option<record<session>>;
DEFINE FIELD turn                  ON classifier_result TYPE option<record<turn>>;
DEFINE FIELD label                 ON classifier_result TYPE string;
DEFINE FIELD target                ON classifier_result TYPE string;
DEFINE FIELD polarity              ON classifier_result TYPE string;
DEFINE FIELD durability            ON classifier_result TYPE string;
DEFINE FIELD confidence            ON classifier_result TYPE float;
DEFINE FIELD method                ON classifier_result TYPE string;
DEFINE FIELD evidence_json         ON classifier_result TYPE string;
DEFINE FIELD signals               ON classifier_result TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts                    ON classifier_result TYPE datetime;
DEFINE FIELD updated_at            ON classifier_result TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS classifier_result_classifier ON classifier_result FIELDS classifier_key, classifier_version;
DEFINE INDEX IF NOT EXISTS classifier_result_turn ON classifier_result FIELDS turn;
DEFINE INDEX IF NOT EXISTS classifier_result_theme ON classifier_result FIELDS classifier_key, label, target, durability;

DEFINE TABLE IF NOT EXISTS classifier_graph_node SCHEMAFULL;
DEFINE FIELD graph_id        ON classifier_graph_node TYPE string;
DEFINE FIELD kind            ON classifier_graph_node TYPE string;
DEFINE FIELD label           ON classifier_graph_node TYPE string;
DEFINE FIELD properties_json ON classifier_graph_node TYPE string;
DEFINE FIELD source_kind     ON classifier_graph_node TYPE string;
DEFINE FIELD updated_at      ON classifier_graph_node TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS classifier_graph_node_graph_id ON classifier_graph_node FIELDS graph_id UNIQUE;
DEFINE INDEX IF NOT EXISTS classifier_graph_node_kind ON classifier_graph_node FIELDS kind;

DEFINE TABLE IF NOT EXISTS classifier_graph_edge SCHEMAFULL;
DEFINE FIELD graph_id        ON classifier_graph_edge TYPE string;
DEFINE FIELD kind            ON classifier_graph_edge TYPE string;
DEFINE FIELD from_id         ON classifier_graph_edge TYPE string;
DEFINE FIELD to_id           ON classifier_graph_edge TYPE string;
DEFINE FIELD evidence_path   ON classifier_graph_edge TYPE string;
DEFINE FIELD properties_json ON classifier_graph_edge TYPE string;
DEFINE FIELD source_kind     ON classifier_graph_edge TYPE string;
DEFINE FIELD updated_at      ON classifier_graph_edge TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS classifier_graph_edge_graph_id ON classifier_graph_edge FIELDS graph_id UNIQUE;
DEFINE INDEX IF NOT EXISTS classifier_graph_edge_kind ON classifier_graph_edge FIELDS kind;
DEFINE INDEX IF NOT EXISTS classifier_graph_edge_from ON classifier_graph_edge FIELDS from_id;
DEFINE INDEX IF NOT EXISTS classifier_graph_edge_to ON classifier_graph_edge FIELDS to_id;

DEFINE TABLE IF NOT EXISTS classifier_graph_fact SCHEMAFULL;
DEFINE FIELD graph_id            ON classifier_graph_fact TYPE string;
DEFINE FIELD kind                ON classifier_graph_fact TYPE string;
DEFINE FIELD subject             ON classifier_graph_fact TYPE string;
DEFINE FIELD predicate           ON classifier_graph_fact TYPE string;
DEFINE FIELD object              ON classifier_graph_fact TYPE option<string>;
DEFINE FIELD value_json          ON classifier_graph_fact TYPE option<string>;
DEFINE FIELD evidence_edges_json ON classifier_graph_fact TYPE string;
DEFINE FIELD properties_json     ON classifier_graph_fact TYPE string;
DEFINE FIELD source_kind         ON classifier_graph_fact TYPE string;
DEFINE FIELD updated_at          ON classifier_graph_fact TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS classifier_graph_fact_graph_id ON classifier_graph_fact FIELDS graph_id UNIQUE;
DEFINE INDEX IF NOT EXISTS classifier_graph_fact_kind ON classifier_graph_fact FIELDS kind;
DEFINE INDEX IF NOT EXISTS classifier_graph_fact_subject ON classifier_graph_fact FIELDS subject;
DEFINE INDEX IF NOT EXISTS classifier_graph_fact_theme ON classifier_graph_fact FIELDS kind, predicate;

DEFINE TABLE IF NOT EXISTS semantic_signal SCHEMAFULL;
DEFINE FIELD kind           ON semantic_signal TYPE string;
DEFINE FIELD label          ON semantic_signal TYPE string;
DEFINE FIELD canonical_text ON semantic_signal TYPE string;
DEFINE FIELD description    ON semantic_signal TYPE option<string>;
DEFINE FIELD method         ON semantic_signal TYPE string;
DEFINE FIELD confidence     ON semantic_signal TYPE float;
DEFINE FIELD first_seen     ON semantic_signal TYPE option<datetime>;
DEFINE FIELD last_seen      ON semantic_signal TYPE option<datetime>;
DEFINE FIELD metrics        ON semantic_signal TYPE option<string>;  -- JSON-encoded
DEFINE INDEX IF NOT EXISTS semantic_signal_kind_label ON semantic_signal FIELDS kind, label UNIQUE;

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
DEFINE FIELD status         ON guidance_version TYPE string DEFAULT 'proposed';
DEFINE FIELD scope          ON guidance_version TYPE option<string>;
DEFINE FIELD risk           ON guidance_version TYPE option<string>;
DEFINE FIELD evidence       ON guidance_version TYPE option<string>;
DEFINE FIELD metrics_before ON guidance_version TYPE option<string>;
DEFINE FIELD metrics_after  ON guidance_version TYPE option<string>;
DEFINE INDEX guidance_version_status ON guidance_version FIELDS status, created_at;

DEFINE TABLE guidance_source SCHEMAFULL;
DEFINE FIELD path              ON guidance_source TYPE string;
DEFINE FIELD kind              ON guidance_source TYPE string;
DEFINE FIELD scope             ON guidance_source TYPE string;
DEFINE FIELD provider          ON guidance_source TYPE string;
DEFINE FIELD evidence_strength ON guidance_source TYPE string;
DEFINE FIELD git_root          ON guidance_source TYPE option<string>;
DEFINE FIELD tracked           ON guidance_source TYPE bool DEFAULT false;
DEFINE FIELD observed_at       ON guidance_source TYPE datetime DEFAULT time::now();
DEFINE INDEX guidance_source_path_uq ON guidance_source FIELDS path UNIQUE;
DEFINE INDEX guidance_source_scope ON guidance_source FIELDS scope, provider;

DEFINE TABLE guidance_revision SCHEMAFULL;
DEFINE FIELD source            ON guidance_revision TYPE option<record<guidance_source>>;
DEFINE FIELD source_path       ON guidance_revision TYPE string;
DEFINE FIELD scope             ON guidance_revision TYPE string;
DEFINE FIELD content_hash      ON guidance_revision TYPE string;
DEFINE FIELD evidence_strength ON guidance_revision TYPE string;
DEFINE FIELD commit_evidence   ON guidance_revision TYPE option<string>;
DEFINE FIELD file_evidence     ON guidance_revision TYPE option<string>;
DEFINE FIELD observed_at       ON guidance_revision TYPE datetime DEFAULT time::now();
DEFINE INDEX guidance_revision_source_hash ON guidance_revision FIELDS source_path, content_hash UNIQUE;
DEFINE INDEX guidance_revision_scope ON guidance_revision FIELDS scope, observed_at;

DEFINE TABLE stack SCHEMAFULL;
DEFINE FIELD name        ON stack TYPE string;
DEFINE FIELD aliases     ON stack TYPE option<string>;  -- JSON-encoded
DEFINE FIELD labels      ON stack TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at  ON stack TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at  ON stack TYPE option<datetime>;
DEFINE INDEX stack_name_uq ON stack FIELDS name UNIQUE;

DEFINE TABLE command_outcome SCHEMAFULL;
DEFINE FIELD tool_call     ON command_outcome TYPE option<record<tool_call>>;
DEFINE FIELD session       ON command_outcome TYPE option<record<session>>;
DEFINE FIELD command_norm  ON command_outcome TYPE option<string>;
DEFINE FIELD command_tool  ON command_outcome TYPE option<string>;
DEFINE FIELD kind          ON command_outcome TYPE string;
DEFINE FIELD status        ON command_outcome TYPE string;
DEFINE FIELD text          ON command_outcome TYPE option<string>;
DEFINE FIELD labels        ON command_outcome TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics       ON command_outcome TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts            ON command_outcome TYPE datetime DEFAULT time::now();
DEFINE INDEX command_outcome_kind_ts ON command_outcome FIELDS kind, ts;
DEFINE INDEX command_outcome_session ON command_outcome FIELDS session, ts;

DEFINE TABLE user_message_ngram SCHEMAFULL;
DEFINE FIELD ngram         ON user_message_ngram TYPE string;
DEFINE FIELD n             ON user_message_ngram TYPE int;
DEFINE FIELD count         ON user_message_ngram TYPE int DEFAULT 0;
DEFINE FIELD sessions      ON user_message_ngram TYPE option<string>;  -- JSON-encoded
DEFINE FIELD near_correction_count ON user_message_ngram TYPE int DEFAULT 0;
DEFINE FIELD near_failed_tool_count ON user_message_ngram TYPE int DEFAULT 0;
DEFINE FIELD near_edit_count ON user_message_ngram TYPE int DEFAULT 0;
DEFINE FIELD near_verification_count ON user_message_ngram TYPE int DEFAULT 0;
DEFINE FIELD first_seen    ON user_message_ngram TYPE option<datetime>;
DEFINE FIELD last_seen     ON user_message_ngram TYPE option<datetime>;
DEFINE INDEX user_message_ngram_n_count ON user_message_ngram FIELDS n, count;
DEFINE INDEX user_message_ngram_text ON user_message_ngram FIELDS ngram;

DEFINE TABLE workflow_epoch SCHEMAFULL;
DEFINE FIELD name          ON workflow_epoch TYPE string;
DEFINE FIELD starts_at     ON workflow_epoch TYPE option<datetime>;
DEFINE FIELD ends_at       ON workflow_epoch TYPE option<datetime>;
DEFINE FIELD evidence_kind ON workflow_epoch TYPE option<string>;
DEFINE FIELD evidence_ref  ON workflow_epoch TYPE option<string>;
DEFINE FIELD notes         ON workflow_epoch TYPE option<string>;
DEFINE INDEX workflow_epoch_name ON workflow_epoch FIELDS name UNIQUE;

DEFINE TABLE session_token_usage SCHEMAFULL;
DEFINE FIELD session       ON session_token_usage TYPE record<session>;
DEFINE FIELD source        ON session_token_usage TYPE string;
DEFINE FIELD workflow_epoch ON session_token_usage TYPE option<record<workflow_epoch>>;
DEFINE FIELD model         ON session_token_usage TYPE option<string>;
DEFINE FIELD prompt_tokens ON session_token_usage TYPE option<int>;
DEFINE FIELD completion_tokens ON session_token_usage TYPE option<int>;
DEFINE FIELD cache_creation_input_tokens ON session_token_usage TYPE option<int>;
DEFINE FIELD cache_read_input_tokens ON session_token_usage TYPE option<int>;
DEFINE FIELD estimated_tokens ON session_token_usage TYPE int;
DEFINE FIELD transcript_bytes ON session_token_usage TYPE int;
DEFINE FIELD context_window ON session_token_usage TYPE option<int>;
DEFINE FIELD model_ref      ON session_token_usage TYPE option<record<agent_model>>;
DEFINE FIELD estimated_input_cost_usd ON session_token_usage TYPE option<float>;
DEFINE FIELD estimated_output_cost_usd ON session_token_usage TYPE option<float>;
DEFINE FIELD estimated_cache_creation_cost_usd ON session_token_usage TYPE option<float>;
DEFINE FIELD estimated_cache_read_cost_usd ON session_token_usage TYPE option<float>;
DEFINE FIELD estimated_cost_usd ON session_token_usage TYPE option<float>;
DEFINE FIELD pricing_source ON session_token_usage TYPE option<string>;
DEFINE FIELD labels        ON session_token_usage TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics       ON session_token_usage TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts            ON session_token_usage TYPE datetime DEFAULT time::now();
DEFINE INDEX session_token_usage_session ON session_token_usage FIELDS session UNIQUE;
DEFINE INDEX session_token_usage_epoch ON session_token_usage FIELDS workflow_epoch, source, ts;
DEFINE INDEX session_token_usage_model ON session_token_usage FIELDS model_ref, ts;

DEFINE TABLE turn_token_usage SCHEMAFULL;
DEFINE FIELD session       ON turn_token_usage TYPE record<session>;
DEFINE FIELD turn          ON turn_token_usage TYPE record<turn>;
DEFINE FIELD seq           ON turn_token_usage TYPE int;
DEFINE FIELD source        ON turn_token_usage TYPE string;
DEFINE FIELD model         ON turn_token_usage TYPE option<string>;
DEFINE FIELD prompt_tokens ON turn_token_usage TYPE option<int>;
DEFINE FIELD completion_tokens ON turn_token_usage TYPE option<int>;
DEFINE FIELD cache_creation_input_tokens ON turn_token_usage TYPE option<int>;
DEFINE FIELD cache_read_input_tokens ON turn_token_usage TYPE option<int>;
DEFINE FIELD fresh_input_tokens ON turn_token_usage TYPE option<int>;
DEFINE FIELD estimated_tokens ON turn_token_usage TYPE int;
DEFINE FIELD model_ref      ON turn_token_usage TYPE option<record<agent_model>>;
DEFINE FIELD estimated_input_cost_usd ON turn_token_usage TYPE option<float>;
DEFINE FIELD estimated_output_cost_usd ON turn_token_usage TYPE option<float>;
DEFINE FIELD estimated_cache_creation_cost_usd ON turn_token_usage TYPE option<float>;
DEFINE FIELD estimated_cache_read_cost_usd ON turn_token_usage TYPE option<float>;
DEFINE FIELD estimated_cost_usd ON turn_token_usage TYPE option<float>;
DEFINE FIELD pricing_source ON turn_token_usage TYPE option<string>;
DEFINE FIELD usage_source   ON turn_token_usage TYPE string;
DEFINE FIELD usage_quality  ON turn_token_usage TYPE string;
DEFINE FIELD raw            ON turn_token_usage TYPE option<string>;
DEFINE FIELD ts             ON turn_token_usage TYPE datetime DEFAULT time::now();
DEFINE INDEX turn_token_usage_turn ON turn_token_usage FIELDS turn UNIQUE;
DEFINE INDEX turn_token_usage_session_seq ON turn_token_usage FIELDS session, seq;
DEFINE INDEX turn_token_usage_model ON turn_token_usage FIELDS model_ref, ts;

DEFINE TABLE session_health SCHEMAFULL;
DEFINE FIELD session       ON session_health TYPE record<session>;
DEFINE FIELD source        ON session_health TYPE string;
DEFINE FIELD workflow_epoch ON session_health TYPE option<record<workflow_epoch>>;
DEFINE FIELD turns         ON session_health TYPE int DEFAULT 0;
DEFINE FIELD tool_calls    ON session_health TYPE int DEFAULT 0;
DEFINE FIELD tool_errors   ON session_health TYPE int DEFAULT 0;
DEFINE FIELD user_corrections ON session_health TYPE int DEFAULT 0;
DEFINE FIELD interruptions ON session_health TYPE int DEFAULT 0;
DEFINE FIELD subagent_dispatches ON session_health TYPE int DEFAULT 0;
DEFINE FIELD plan_snapshots ON session_health TYPE int DEFAULT 0;
DEFINE FIELD estimated_tokens ON session_health TYPE int DEFAULT 0;
DEFINE FIELD cache_read_ratio ON session_health TYPE option<float>;
DEFINE FIELD cache_creation_ratio ON session_health TYPE option<float>;
DEFINE FIELD context_pressure ON session_health TYPE string DEFAULT 'unknown';
-- Precomputed attention metrics for the graph-explorer endpoint (issue #77).
-- task_label: first organic-task user turn excerpt; turn counts by role/intent.
-- Derived from turns once per ingest so the dashboard avoids per-row turn scans.
DEFINE FIELD task_label    ON session_health TYPE option<string>;
DEFINE FIELD user_turns    ON session_health TYPE int DEFAULT 0;
DEFINE FIELD assistant_turns ON session_health TYPE int DEFAULT 0;
DEFINE FIELD correction_turns ON session_health TYPE int DEFAULT 0;
DEFINE FIELD labels        ON session_health TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics       ON session_health TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts            ON session_health TYPE datetime DEFAULT time::now();
DEFINE INDEX session_health_session ON session_health FIELDS session UNIQUE;
DEFINE INDEX session_health_epoch ON session_health FIELDS workflow_epoch, source, ts;

DEFINE TABLE commit_classification SCHEMAFULL;
DEFINE FIELD commit        ON commit_classification TYPE record<commit>;
DEFINE FIELD repository    ON commit_classification TYPE option<record<repository>>;
DEFINE FIELD kind          ON commit_classification TYPE string;
DEFINE FIELD confidence    ON commit_classification TYPE string;
DEFINE FIELD message       ON commit_classification TYPE option<string>;
DEFINE FIELD labels        ON commit_classification TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics       ON commit_classification TYPE option<string>;  -- JSON-encoded
DEFINE FIELD ts            ON commit_classification TYPE datetime DEFAULT time::now();
DEFINE INDEX commit_classification_commit ON commit_classification FIELDS commit UNIQUE;
DEFINE INDEX commit_classification_kind_ts ON commit_classification FIELDS kind, ts;

DEFINE TABLE branch SCHEMAFULL;
DEFINE FIELD repository     ON branch TYPE record<repository>;
DEFINE FIELD name           ON branch TYPE string;
DEFINE FIELD head_sha       ON branch TYPE option<string>;
DEFINE FIELD upstream       ON branch TYPE option<string>;
DEFINE FIELD is_default     ON branch TYPE bool DEFAULT false;
DEFINE FIELD first_seen_at  ON branch TYPE datetime DEFAULT time::now();
DEFINE FIELD last_seen_at   ON branch TYPE option<datetime>;
DEFINE INDEX branch_repo_name ON branch FIELDS repository, name UNIQUE;

DEFINE TABLE pull_request SCHEMAFULL;
DEFINE FIELD repository     ON pull_request TYPE record<repository>;
DEFINE FIELD provider       ON pull_request TYPE string DEFAULT 'github';
DEFINE FIELD number         ON pull_request TYPE int;
DEFINE FIELD title          ON pull_request TYPE string;
DEFINE FIELD state          ON pull_request TYPE string;
DEFINE FIELD base_branch    ON pull_request TYPE option<string>;
DEFINE FIELD head_branch    ON pull_request TYPE option<string>;
DEFINE FIELD head_sha       ON pull_request TYPE option<string>;
DEFINE FIELD merge_sha      ON pull_request TYPE option<string>;
DEFINE FIELD author         ON pull_request TYPE option<string>;
DEFINE FIELD url            ON pull_request TYPE option<string>;
DEFINE FIELD opened_at      ON pull_request TYPE option<datetime>;
DEFINE FIELD closed_at      ON pull_request TYPE option<datetime>;
DEFINE FIELD merged_at      ON pull_request TYPE option<datetime>;
DEFINE FIELD additions      ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD deletions      ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD changed_files  ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD commit_count   ON pull_request TYPE int DEFAULT 0;
DEFINE FIELD labels         ON pull_request TYPE option<string>;
DEFINE FIELD raw            ON pull_request TYPE option<string>;
DEFINE FIELD updated_at     ON pull_request TYPE option<datetime>;
DEFINE INDEX pull_request_repo_number ON pull_request FIELDS repository, number UNIQUE;
DEFINE INDEX pull_request_state ON pull_request FIELDS repository, state, updated_at;

DEFINE TABLE review_event SCHEMAFULL;
DEFINE FIELD pull_request   ON review_event TYPE record<pull_request>;
DEFINE FIELD repository     ON review_event TYPE record<repository>;
DEFINE FIELD reviewer       ON review_event TYPE option<string>;
DEFINE FIELD reviewer_kind  ON review_event TYPE string DEFAULT 'unknown';
DEFINE FIELD state          ON review_event TYPE string;
DEFINE FIELD body_excerpt   ON review_event TYPE option<string>;
DEFINE FIELD severity       ON review_event TYPE string DEFAULT 'unknown';
DEFINE FIELD category       ON review_event TYPE string DEFAULT 'unknown';
DEFINE FIELD unresolved     ON review_event TYPE bool DEFAULT false;
DEFINE FIELD raw            ON review_event TYPE option<string>;
DEFINE FIELD ts             ON review_event TYPE datetime;
DEFINE INDEX review_event_pr_ts ON review_event FIELDS pull_request, ts;
DEFINE INDEX review_event_severity ON review_event FIELDS repository, severity, ts;

DEFINE TABLE check_run SCHEMAFULL;
DEFINE FIELD pull_request   ON check_run TYPE option<record<pull_request>>;
DEFINE FIELD commit         ON check_run TYPE option<record<commit>>;
DEFINE FIELD repository     ON check_run TYPE record<repository>;
DEFINE FIELD provider       ON check_run TYPE string DEFAULT 'github';
DEFINE FIELD name           ON check_run TYPE string;
DEFINE FIELD status         ON check_run TYPE string;
DEFINE FIELD conclusion     ON check_run TYPE option<string>;
DEFINE FIELD url            ON check_run TYPE option<string>;
DEFINE FIELD raw            ON check_run TYPE option<string>;
DEFINE FIELD started_at     ON check_run TYPE option<datetime>;
DEFINE FIELD completed_at   ON check_run TYPE option<datetime>;
DEFINE INDEX check_run_pr ON check_run FIELDS pull_request, status, conclusion;
DEFINE INDEX check_run_commit ON check_run FIELDS commit, status, conclusion;

DEFINE TABLE delivery_outcome SCHEMAFULL;
DEFINE FIELD session        ON delivery_outcome TYPE option<record<session>>;
DEFINE FIELD repository     ON delivery_outcome TYPE option<record<repository>>;
DEFINE FIELD checkout       ON delivery_outcome TYPE option<record<checkout>>;
DEFINE FIELD pull_request   ON delivery_outcome TYPE option<record<pull_request>>;
DEFINE FIELD status         ON delivery_outcome TYPE string;
DEFINE FIELD promotion_path ON delivery_outcome TYPE string DEFAULT 'unknown';
DEFINE FIELD main_branch    ON delivery_outcome TYPE option<string>;
DEFINE FIELD produced_commits ON delivery_outcome TYPE option<string>;
DEFINE FIELD promoted_commits ON delivery_outcome TYPE option<string>;
DEFINE FIELD pr_size        ON delivery_outcome TYPE option<string>;
DEFINE FIELD review_pain    ON delivery_outcome TYPE option<string>;
DEFINE FIELD phase_metrics  ON delivery_outcome TYPE option<string>;
DEFINE FIELD confidence     ON delivery_outcome TYPE string DEFAULT 'medium';
DEFINE FIELD evidence       ON delivery_outcome TYPE option<string>;
DEFINE FIELD created_at     ON delivery_outcome TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON delivery_outcome TYPE option<datetime>;
DEFINE INDEX delivery_session ON delivery_outcome FIELDS session UNIQUE;
DEFINE INDEX delivery_pr ON delivery_outcome FIELDS pull_request;
DEFINE INDEX delivery_status ON delivery_outcome FIELDS repository, status, updated_at;

DEFINE TABLE phase_span SCHEMAFULL;
DEFINE FIELD session        ON phase_span TYPE record<session>;
DEFINE FIELD phase          ON phase_span TYPE string;
DEFINE FIELD start_turn     ON phase_span TYPE option<record<turn>>;
DEFINE FIELD end_turn       ON phase_span TYPE option<record<turn>>;
DEFINE FIELD start_ts       ON phase_span TYPE datetime;
DEFINE FIELD end_ts         ON phase_span TYPE datetime;
DEFINE FIELD duration_ms    ON phase_span TYPE int;
DEFINE FIELD user_turns     ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD assistant_turns ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD tool_calls     ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD files_read     ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD files_touched  ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD tests_run      ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD interruptions  ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD corrections    ON phase_span TYPE int DEFAULT 0;
DEFINE FIELD metrics        ON phase_span TYPE option<string>;
DEFINE FIELD evidence       ON phase_span TYPE option<string>;
DEFINE INDEX phase_span_session_phase ON phase_span FIELDS session, phase;

DEFINE TABLE skill_candidate SCHEMAFULL;
DEFINE FIELD name          ON skill_candidate TYPE string;
DEFINE FIELD trigger_pattern ON skill_candidate TYPE string;
DEFINE FIELD suspected_gap ON skill_candidate TYPE string;
DEFINE FIELD proposed_behavior ON skill_candidate TYPE string;
DEFINE FIELD confidence    ON skill_candidate TYPE string;
DEFINE FIELD expected_impact ON skill_candidate TYPE option<string>;
DEFINE FIELD status        ON skill_candidate TYPE string DEFAULT 'candidate';
DEFINE FIELD labels        ON skill_candidate TYPE option<string>;  -- JSON-encoded
DEFINE FIELD metrics       ON skill_candidate TYPE option<string>;  -- JSON-encoded
DEFINE FIELD created_at    ON skill_candidate TYPE datetime DEFAULT time::now();
DEFINE INDEX skill_candidate_name ON skill_candidate FIELDS name UNIQUE;
DEFINE INDEX skill_candidate_status ON skill_candidate FIELDS status, created_at;

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

-- ==== Skill roles (P3.1) ====
-- Multi-role natural: one skill -> many plays_role edges. Weighted query
-- joins invoked -> skill -> plays_role -> role.

DEFINE TABLE IF NOT EXISTS role SCHEMAFULL;
DEFINE FIELD name   ON role TYPE string;
DEFINE FIELD weight ON role TYPE float DEFAULT 1.0;
DEFINE INDEX IF NOT EXISTS role_name_uq ON role FIELDS name UNIQUE;

DEFINE TABLE IF NOT EXISTS plays_role TYPE RELATION FROM skill TO role;
DEFINE FIELD confidence ON plays_role TYPE float DEFAULT 1.0;
DEFINE FIELD source     ON plays_role TYPE string;
DEFINE FIELD weight     ON plays_role TYPE option<float>;
DEFINE FIELD rationale  ON plays_role TYPE option<string>;
DEFINE FIELD since      ON plays_role TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS plays_role_in  ON plays_role FIELDS in;
DEFINE INDEX IF NOT EXISTS plays_role_out ON plays_role FIELDS out;

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
-- Position fields for P3.1: turn_index = seq at write time; total_turns and
-- is_first are backfilled by the invoked-positions stage after all transcripts
-- are ingested. option<T> so existing rows carry NONE until the backfill runs.
DEFINE FIELD turn_index   ON invoked TYPE option<int>;
DEFINE FIELD total_turns  ON invoked TYPE option<int>;
DEFINE FIELD is_first     ON invoked TYPE option<bool>;
-- Most cmdTaste/cmdSearch/cmdUnused subqueries filter
-- `WHERE out = $skill_id AND ts > time::now() - Nd`. Composite index
-- covers both predicates from one seek.
DEFINE INDEX IF NOT EXISTS invoked_out_ts ON invoked FIELDS out, ts;
DEFINE INDEX IF NOT EXISTS invoked_in_out_args ON invoked FIELDS in, out, args;

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
DEFINE INDEX IF NOT EXISTS edited_in_out_tool ON edited FIELDS in, out, tool;

DEFINE TABLE mentioned_file TYPE RELATION FROM turn TO file;
DEFINE FIELD source       ON mentioned_file TYPE string DEFAULT "text"; -- 'text' | 'tool_input' | 'tool_output'
DEFINE FIELD confidence   ON mentioned_file TYPE option<float>;
DEFINE FIELD excerpt      ON mentioned_file TYPE option<string>;
DEFINE FIELD ts           ON mentioned_file TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS mentioned_file_in ON mentioned_file FIELDS in;
DEFINE INDEX IF NOT EXISTS mentioned_file_out ON mentioned_file FIELDS out;
DEFINE INDEX IF NOT EXISTS mentioned_file_in_out_source ON mentioned_file FIELDS in, out, source;

DEFINE TABLE mentioned_symbol TYPE RELATION FROM turn TO symbol;
DEFINE FIELD source       ON mentioned_symbol TYPE string DEFAULT "text";
DEFINE FIELD confidence   ON mentioned_symbol TYPE option<float>;
DEFINE FIELD excerpt      ON mentioned_symbol TYPE option<string>;
DEFINE FIELD ts           ON mentioned_symbol TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS mentioned_symbol_in ON mentioned_symbol FIELDS in;
DEFINE INDEX IF NOT EXISTS mentioned_symbol_out ON mentioned_symbol FIELDS out;

DEFINE TABLE mentioned_error TYPE RELATION FROM turn TO error_signature;
DEFINE FIELD source       ON mentioned_error TYPE string DEFAULT "text";
DEFINE FIELD confidence   ON mentioned_error TYPE option<float>;
DEFINE FIELD excerpt      ON mentioned_error TYPE option<string>;
DEFINE FIELD ts           ON mentioned_error TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS mentioned_error_in ON mentioned_error FIELDS in;
DEFINE INDEX IF NOT EXISTS mentioned_error_out ON mentioned_error FIELDS out;

DEFINE TABLE read_file TYPE RELATION FROM tool_call TO file;
DEFINE FIELD evidence    ON read_file TYPE option<string>;      -- 'tool_name' | 'command_norm'
DEFINE FIELD path_seen   ON read_file TYPE option<string>;
DEFINE FIELD absolute_path_seen ON read_file TYPE option<string>;
DEFINE FIELD excerpt     ON read_file TYPE option<string>;
DEFINE FIELD ts          ON read_file TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS read_file_in ON read_file FIELDS in;
DEFINE INDEX IF NOT EXISTS read_file_out ON read_file FIELDS out;

DEFINE TABLE searched_file TYPE RELATION FROM tool_call TO file;
DEFINE FIELD evidence    ON searched_file TYPE option<string>;  -- 'tool_name' | 'command_norm' | 'output_match'
DEFINE FIELD path_seen   ON searched_file TYPE option<string>;
DEFINE FIELD absolute_path_seen ON searched_file TYPE option<string>;
DEFINE FIELD excerpt     ON searched_file TYPE option<string>;
DEFINE FIELD ts          ON searched_file TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS searched_file_in ON searched_file FIELDS in;
DEFINE INDEX IF NOT EXISTS searched_file_out ON searched_file FIELDS out;

DEFINE TABLE corrected_by TYPE RELATION FROM turn TO turn;      -- assistant turn → next user turn that pushed back
DEFINE FIELD pattern      ON corrected_by TYPE option<string>;  -- which negation pattern matched
DEFINE FIELD ts           ON corrected_by TYPE datetime;
-- `corrected_by` lookups in cmdTaste's correction-rate subquery walk via `in`
-- (the assistant turn that was corrected).
DEFINE INDEX IF NOT EXISTS corrected_by_in ON corrected_by FIELDS in;

DEFINE TABLE IF NOT EXISTS expresses TYPE RELATION FROM turn TO semantic_signal SCHEMAFULL;
DEFINE FIELD analysis     ON expresses TYPE record<turn_analysis>;
DEFINE FIELD session      ON expresses TYPE option<record<session>>;
DEFINE FIELD confidence   ON expresses TYPE float;
DEFINE FIELD method       ON expresses TYPE string;
DEFINE FIELD ts           ON expresses TYPE datetime;
DEFINE INDEX IF NOT EXISTS expresses_in ON expresses FIELDS in;
DEFINE INDEX IF NOT EXISTS expresses_out ON expresses FIELDS out;
DEFINE INDEX IF NOT EXISTS expresses_session_ts ON expresses FIELDS session, ts;

DEFINE TABLE IF NOT EXISTS reacts_to TYPE RELATION FROM turn TO turn SCHEMAFULL;
DEFINE FIELD session      ON reacts_to TYPE option<record<session>>;
DEFINE FIELD polarity     ON reacts_to TYPE string;
DEFINE FIELD act          ON reacts_to TYPE string;
DEFINE FIELD confidence   ON reacts_to TYPE float;
DEFINE FIELD signal       ON reacts_to TYPE option<record<semantic_signal>>;
DEFINE FIELD ts           ON reacts_to TYPE datetime;
DEFINE INDEX IF NOT EXISTS reacts_to_in ON reacts_to FIELDS in;
DEFINE INDEX IF NOT EXISTS reacts_to_out ON reacts_to FIELDS out;
DEFINE INDEX IF NOT EXISTS reacts_to_session_ts ON reacts_to FIELDS session, ts;

DEFINE TABLE IF NOT EXISTS has_classification TYPE RELATION FROM turn TO classifier_result SCHEMAFULL;
DEFINE FIELD classifier_key ON has_classification TYPE string;
DEFINE FIELD label          ON has_classification TYPE string;
DEFINE FIELD target         ON has_classification TYPE string;
DEFINE FIELD confidence     ON has_classification TYPE float;
DEFINE FIELD ts             ON has_classification TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS has_classification_in ON has_classification FIELDS in;
DEFINE INDEX IF NOT EXISTS has_classification_out ON has_classification FIELDS out;
DEFINE INDEX IF NOT EXISTS has_classification_theme ON has_classification FIELDS classifier_key, label, target;

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

DEFINE TABLE later_fixed_by TYPE RELATION FROM commit TO commit;
DEFINE FIELD repository   ON later_fixed_by TYPE option<record<repository>>;
DEFINE FIELD overlap_files ON later_fixed_by TYPE option<string>;  -- JSON-encoded
DEFINE FIELD overlap_count ON later_fixed_by TYPE int DEFAULT 0;
DEFINE FIELD days_between ON later_fixed_by TYPE option<float>;
DEFINE FIELD confidence   ON later_fixed_by TYPE string;
DEFINE FIELD reason       ON later_fixed_by TYPE option<string>;
DEFINE FIELD ts           ON later_fixed_by TYPE datetime DEFAULT time::now();

DEFINE TABLE suggests_skill TYPE RELATION FROM commit TO skill_candidate;
DEFINE FIELD reason        ON suggests_skill TYPE option<string>;
DEFINE FIELD evidence      ON suggests_skill TYPE option<string>;  -- JSON-encoded
DEFINE FIELD confidence    ON suggests_skill TYPE string;
DEFINE FIELD ts            ON suggests_skill TYPE datetime DEFAULT time::now();
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
DEFINE INDEX IF NOT EXISTS concerns_in_out_kind ON concerns FIELDS in, out, kind;

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

-- ---------------------------------------------------------------------------
-- Parent session -> spawned child session. Lets us reconstruct work episodes
-- (one user-driven workflow that fans out across many subagent sessions) from
-- the flat session table. Derived from `tool_call` rows where
-- name='spawn_agent' or name='Task': output payload carries the child's
-- session id (codex uses `agent_id`, Claude Task uses the subagent transcript
-- id), and we RELATE the row's session to that target.
-- ---------------------------------------------------------------------------
DEFINE TABLE spawned TYPE RELATION FROM session TO session;
DEFINE FIELD ts           ON spawned TYPE datetime DEFAULT time::now();
DEFINE FIELD tool         ON spawned TYPE option<string>;       -- e.g. "spawn_agent" | "Task"
DEFINE FIELD tool_call    ON spawned TYPE option<record<tool_call>>;
DEFINE FIELD nickname     ON spawned TYPE option<string>;       -- codex assigns "Turing", "Babbage", etc.
DEFINE INDEX spawned_in   ON spawned FIELDS in;
DEFINE INDEX spawned_out  ON spawned FIELDS out;

DEFINE TABLE agent_event_child TYPE RELATION FROM agent_event TO agent_event SCHEMAFULL;
DEFINE FIELD agent_session ON agent_event_child TYPE record<agent_session>;
DEFINE FIELD provider      ON agent_event_child TYPE record<agent_provider>;
DEFINE FIELD kind          ON agent_event_child TYPE string DEFAULT "parent";
DEFINE FIELD ts            ON agent_event_child TYPE datetime DEFAULT time::now();
DEFINE INDEX agent_event_child_in ON agent_event_child FIELDS in;
DEFINE INDEX agent_event_child_out ON agent_event_child FIELDS out;

DEFINE TABLE used_model TYPE RELATION FROM session TO agent_model SCHEMAFULL;
DEFINE FIELD session_token_usage ON used_model TYPE option<record<session_token_usage>>;
DEFINE FIELD source              ON used_model TYPE string;
DEFINE FIELD estimated_tokens    ON used_model TYPE int DEFAULT 0;
DEFINE FIELD estimated_cost_usd  ON used_model TYPE option<float>;
DEFINE FIELD pricing_source      ON used_model TYPE option<string>;
DEFINE FIELD ts                  ON used_model TYPE datetime DEFAULT time::now();
DEFINE INDEX used_model_in ON used_model FIELDS in;
DEFINE INDEX used_model_out ON used_model FIELDS out;

DEFINE TABLE agent_used_model TYPE RELATION FROM agent_session TO agent_model SCHEMAFULL;
DEFINE FIELD provider ON agent_used_model TYPE record<agent_provider>;
DEFINE FIELD source   ON agent_used_model TYPE string;
DEFINE FIELD ts       ON agent_used_model TYPE datetime DEFAULT time::now();
DEFINE INDEX agent_used_model_in ON agent_used_model FIELDS in;
DEFINE INDEX agent_used_model_out ON agent_used_model FIELDS out;

-- ==== Materialized views (computed at query time) ====

-- Per-skill counts, recent boost
-- Usage:
--   SELECT name, taste FROM skill ORDER BY taste DESC LIMIT 20;
-- where taste joins counts of (invoked) - (corrected_after_invoked) + commits-after.
-- View intentionally not DEFINE'd here; CLI computes via parameterized SurrealQL
-- to keep this schema migration-cheap.

-- ---------------------------------------------------------------------------
-- User-facing triage decisions on skills. The dashboard "Skill Triage" view
-- writes here; downstream queries can filter `archived` skills out of the
-- leaderboard. We never delete: keep history of decision flips with `decided_at`.
-- ---------------------------------------------------------------------------
DEFINE TABLE skill_triage_decision SCHEMAFULL;
DEFINE FIELD skill_name ON skill_triage_decision TYPE string;
DEFINE FIELD decision   ON skill_triage_decision TYPE string;  -- keep | archive | review
DEFINE FIELD reason     ON skill_triage_decision TYPE option<string>;
DEFINE FIELD decided_at ON skill_triage_decision TYPE datetime DEFAULT time::now();
DEFINE INDEX skill_triage_decision_name ON skill_triage_decision FIELDS skill_name UNIQUE;

-- ---------------------------------------------------------------------------
-- Native agent-harness hook evidence. These rows describe the harness layer
-- itself (Claude/Codex lifecycle hooks), not ax's experimental recall hook.
-- One Harness Hook Event may invoke multiple Hook Commands.
-- ---------------------------------------------------------------------------
DEFINE TABLE harness_hook_event SCHEMAFULL;
DEFINE FIELD session         ON harness_hook_event TYPE record<session>;
DEFINE FIELD ts              ON harness_hook_event TYPE datetime;
DEFINE FIELD harness         ON harness_hook_event TYPE string;                 -- claude | codex
DEFINE FIELD event_name      ON harness_hook_event TYPE string;                 -- PreToolUse | PostToolUse | SessionStart | ...
DEFINE FIELD hook_name       ON harness_hook_event TYPE string;                 -- e.g. PreToolUse:Bash
DEFINE FIELD tool_call_id    ON harness_hook_event TYPE option<string>;
DEFINE FIELD tool_call       ON harness_hook_event TYPE option<record<tool_call>>;
DEFINE FIELD cwd             ON harness_hook_event TYPE option<string>;
DEFINE FIELD transcript_uuid ON harness_hook_event TYPE option<string>;
DEFINE FIELD source_type     ON harness_hook_event TYPE string;                 -- hook_progress | hook_success | hook_blocking_error | hook_additional_context
DEFINE INDEX harness_hook_event_by_ts      ON harness_hook_event FIELDS ts;
DEFINE INDEX harness_hook_event_by_session ON harness_hook_event FIELDS session;
DEFINE INDEX harness_hook_event_by_name    ON harness_hook_event FIELDS hook_name;
DEFINE INDEX harness_hook_event_by_tool    ON harness_hook_event FIELDS tool_call;

DEFINE TABLE hook_command_invocation SCHEMAFULL;
DEFINE FIELD hook_event             ON hook_command_invocation TYPE record<harness_hook_event>;
DEFINE FIELD session                ON hook_command_invocation TYPE record<session>;
DEFINE FIELD ts                     ON hook_command_invocation TYPE datetime;
DEFINE FIELD harness                ON hook_command_invocation TYPE string;      -- claude | codex
DEFINE FIELD event_name             ON hook_command_invocation TYPE string;
DEFINE FIELD hook_name              ON hook_command_invocation TYPE string;
DEFINE FIELD tool_call_id           ON hook_command_invocation TYPE option<string>;
DEFINE FIELD tool_call              ON hook_command_invocation TYPE option<record<tool_call>>;
DEFINE FIELD command                ON hook_command_invocation TYPE string;
DEFINE FIELD command_hash           ON hook_command_invocation TYPE string;
DEFINE FIELD provider_status        ON hook_command_invocation TYPE string;      -- progress_only | success | blocking_error
DEFINE FIELD effect                 ON hook_command_invocation TYPE string;      -- allowed | blocked | injected_context | modified_input | notified | no_op | unknown
DEFINE FIELD exit_code              ON hook_command_invocation TYPE option<int>;
DEFINE FIELD duration_ms            ON hook_command_invocation TYPE option<int>;
DEFINE FIELD stdout_excerpt         ON hook_command_invocation TYPE option<string>;
DEFINE FIELD stderr_excerpt         ON hook_command_invocation TYPE option<string>;
DEFINE FIELD content_excerpt        ON hook_command_invocation TYPE option<string>;
DEFINE FIELD blocking_error_excerpt ON hook_command_invocation TYPE option<string>;
DEFINE INDEX hook_command_invocation_by_ts      ON hook_command_invocation FIELDS ts;
DEFINE INDEX hook_command_invocation_by_session ON hook_command_invocation FIELDS session;
DEFINE INDEX hook_command_invocation_by_event   ON hook_command_invocation FIELDS hook_event;
DEFINE INDEX hook_command_invocation_by_command ON hook_command_invocation FIELDS command_hash;
DEFINE INDEX hook_command_invocation_by_status  ON hook_command_invocation FIELDS provider_status;
DEFINE INDEX hook_command_invocation_by_effect  ON hook_command_invocation FIELDS effect;

-- ---------------------------------------------------------------------------
-- Generic feedback case definitions and deterministic backtest results.
-- Case types encode "what behavior should follow this evidence?" without
-- creating hook-specific tables. Results are per evidence item/run.
-- ---------------------------------------------------------------------------
DEFINE TABLE feedback_case_type SCHEMAFULL;
DEFINE FIELD name             ON feedback_case_type TYPE string;
DEFINE FIELD title            ON feedback_case_type TYPE string;
DEFINE FIELD target_kind      ON feedback_case_type TYPE string;                 -- hook_command_invocation | tool_call | session | ...
DEFINE FIELD selector_json    ON feedback_case_type TYPE string;                 -- JSON-encoded selector
DEFINE FIELD rule_kind        ON feedback_case_type TYPE string;                 -- deterministic | ai_review | hybrid
DEFINE FIELD rule_json        ON feedback_case_type TYPE string;                 -- JSON-encoded rule
DEFINE FIELD status           ON feedback_case_type TYPE string DEFAULT 'active'; -- active | paused | retired
DEFINE FIELD created_at       ON feedback_case_type TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at       ON feedback_case_type TYPE option<datetime>;
DEFINE INDEX feedback_case_type_name ON feedback_case_type FIELDS name UNIQUE;
DEFINE INDEX feedback_case_type_status ON feedback_case_type FIELDS status;

DEFINE TABLE feedback_case_result SCHEMAFULL;
DEFINE FIELD case_type        ON feedback_case_result TYPE record<feedback_case_type>;
DEFINE FIELD target_kind      ON feedback_case_result TYPE string;
DEFINE FIELD target           ON feedback_case_result TYPE option<record<hook_command_invocation>>;
DEFINE FIELD session          ON feedback_case_result TYPE option<record<session>>;
DEFINE FIELD ts               ON feedback_case_result TYPE datetime;
DEFINE FIELD status           ON feedback_case_result TYPE string;               -- passed | failed | inconclusive
DEFINE FIELD reason           ON feedback_case_result TYPE string;
DEFINE FIELD window_json      ON feedback_case_result TYPE string;               -- JSON-encoded inspected window
DEFINE FIELD evidence_json    ON feedback_case_result TYPE string;               -- JSON-encoded matched evidence
DEFINE FIELD observed_at      ON feedback_case_result TYPE datetime DEFAULT time::now();
DEFINE INDEX feedback_case_result_by_case ON feedback_case_result FIELDS case_type, observed_at;
DEFINE INDEX feedback_case_result_by_status ON feedback_case_result FIELDS status;
DEFINE INDEX feedback_case_result_by_session ON feedback_case_result FIELDS session;

-- ---------------------------------------------------------------------------
-- Hook-fire telemetry. Every `axctl hook file-context` decision (inject or
-- skip) writes a row here. Codex transcripts replay-synthesize rows too.
-- See docs/superpowers/specs/2026-05-17-hook-fire-telemetry-design.md.
--
-- Record id is sha1("harness|session_id|file_path|ts_ms|event").slice(0,16)
-- so Codex replay can upsert idempotently on re-ingest.
-- ---------------------------------------------------------------------------
DEFINE TABLE hook_fire SCHEMAFULL;
-- Common telemetry base fields (mirrors src/lib/telemetry-base.ts).
DEFINE FIELD ts         ON hook_fire TYPE datetime;
DEFINE FIELD kind       ON hook_fire TYPE string;                       -- always "hook_fire"
DEFINE FIELD session    ON hook_fire TYPE option<record<session>>;
DEFINE FIELD file       ON hook_fire TYPE option<record<file>>;
DEFINE FIELD file_path  ON hook_fire TYPE string;                       -- raw path even when no file record exists
DEFINE FIELD harness    ON hook_fire TYPE string;                       -- claude | codex | unknown
DEFINE FIELD ok         ON hook_fire TYPE bool;
DEFINE FIELD latency_ms ON hook_fire TYPE int;
-- Hook-fire-specific fields.
DEFINE FIELD event                     ON hook_fire TYPE string;        -- pre-edit | read | write | search | unknown
DEFINE FIELD inject                    ON hook_fire TYPE bool;
DEFINE FIELD reason                    ON hook_fire TYPE string;        -- high_signal | suppressed_path | no_prior_sessions | low_signal_only | no_files
DEFINE FIELD prior_sessions_considered ON hook_fire TYPE int;
DEFINE FIELD task_excerpt              ON hook_fire TYPE string;        -- clipped 240 chars
DEFINE FIELD top_prior_sessions        ON hook_fire TYPE array<record<session>>;
DEFINE FIELD injected_titles           ON hook_fire TYPE array<string> DEFAULT [];   -- clipped titles of injected sessions (max 3, empty when inject=false)

DEFINE INDEX hook_fire_by_ts      ON hook_fire FIELDS ts;
DEFINE INDEX hook_fire_by_session ON hook_fire FIELDS session;
DEFINE INDEX hook_fire_by_file    ON hook_fire FIELDS file;
DEFINE INDEX hook_fire_by_reason  ON hook_fire FIELDS reason;

-- ==== Proposal (polymorphic shortlist) ====
-- One row per repeated workflow we might package. `form` selects which
-- per-form payload table carries the typed details. `dedupe_sig` is a
-- hash of the normalized trigger pattern so re-derivation never produces
-- duplicate proposals. `baseline` is a JSON snapshot frozen at
-- created_at (NOT accept-time) to avoid Hawthorne bias on verdicts.
DEFINE TABLE proposal SCHEMAFULL;
DEFINE FIELD form          ON proposal TYPE string;
    -- skill | subagent | hook | guidance | automation
DEFINE FIELD title         ON proposal TYPE string;
DEFINE FIELD hypothesis    ON proposal TYPE string;
DEFINE FIELD dedupe_sig    ON proposal TYPE string;
DEFINE FIELD frequency     ON proposal TYPE int DEFAULT 0;
DEFINE FIELD confidence    ON proposal TYPE string;
    -- low | medium | high
DEFINE FIELD status        ON proposal TYPE string DEFAULT 'open';
    -- open | accepted | rejected | superseded
DEFINE FIELD reject_reason ON proposal TYPE option<string>;
DEFINE FIELD baseline      ON proposal TYPE option<string>;
DEFINE FIELD created_at    ON proposal TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at    ON proposal TYPE option<datetime>;
DEFINE INDEX proposal_dedupe_uq    ON proposal FIELDS dedupe_sig UNIQUE;
DEFINE INDEX proposal_status_freq  ON proposal FIELDS status, frequency;
DEFINE INDEX proposal_form_status  ON proposal FIELDS form, status, created_at;

-- ==== Per-form payload tables ====
-- One row per proposal of the matching form. Typed fields per form avoid
-- the JSON-blob trap that killed the prior orphan tables.

DEFINE TABLE skill_proposal SCHEMAFULL;
DEFINE FIELD proposal           ON skill_proposal TYPE record<proposal> REFERENCE ON DELETE CASCADE;
DEFINE FIELD trigger_pattern    ON skill_proposal TYPE string;
DEFINE FIELD suspected_gap      ON skill_proposal TYPE string;
DEFINE FIELD proposed_behavior  ON skill_proposal TYPE string;
DEFINE FIELD expected_impact    ON skill_proposal TYPE option<string>;
DEFINE INDEX skill_proposal_uq  ON skill_proposal FIELDS proposal UNIQUE;

DEFINE TABLE subagent_proposal SCHEMAFULL;
DEFINE FIELD proposal              ON subagent_proposal TYPE record<proposal> REFERENCE ON DELETE CASCADE;
DEFINE FIELD bounded_role          ON subagent_proposal TYPE string;
DEFINE FIELD delegation_trigger    ON subagent_proposal TYPE string;
    -- pattern matched against Task tool calls (see opportunity definition below)
DEFINE FIELD example_task_patterns ON subagent_proposal TYPE array<string> DEFAULT [];
DEFINE INDEX subagent_proposal_uq  ON subagent_proposal FIELDS proposal UNIQUE;

DEFINE TABLE hook_proposal SCHEMAFULL;
DEFINE FIELD proposal       ON hook_proposal TYPE record<proposal> REFERENCE ON DELETE CASCADE;
DEFINE FIELD event_name     ON hook_proposal TYPE string;
    -- PreToolUse | PostToolUse | SessionStart | ...
DEFINE FIELD target_tool    ON hook_proposal TYPE option<string>;
DEFINE FIELD hook_command   ON hook_proposal TYPE string;
DEFINE FIELD recovery_path      ON hook_proposal TYPE option<string>;
DEFINE FIELD smoke_test_command ON hook_proposal TYPE option<string>;
DEFINE FIELD disable_command    ON hook_proposal TYPE option<string>;
DEFINE FIELD failure_mode       ON hook_proposal TYPE option<string>;
    -- fail_open | fail_closed
DEFINE INDEX hook_proposal_uq ON hook_proposal FIELDS proposal UNIQUE;

DEFINE TABLE guidance_proposal SCHEMAFULL;
DEFINE FIELD proposal        ON guidance_proposal TYPE record<proposal> REFERENCE ON DELETE CASCADE;
DEFINE FIELD file_target     ON guidance_proposal TYPE string;
    -- e.g. "CLAUDE.md", "~/.claude/CLAUDE.md"
DEFINE FIELD section         ON guidance_proposal TYPE option<string>;
DEFINE FIELD suggested_text  ON guidance_proposal TYPE string;
DEFINE INDEX guidance_proposal_uq ON guidance_proposal FIELDS proposal UNIQUE;

DEFINE TABLE automation_proposal SCHEMAFULL;
DEFINE FIELD proposal        ON automation_proposal TYPE record<proposal> REFERENCE ON DELETE CASCADE;
DEFINE FIELD trigger_signal  ON automation_proposal TYPE string;
DEFINE FIELD schedule        ON automation_proposal TYPE option<string>;
    -- cron expression, "weekly", etc; null = event-driven
DEFINE FIELD action          ON automation_proposal TYPE string;
DEFINE FIELD recovery_path      ON automation_proposal TYPE option<string>;
DEFINE FIELD smoke_test_command ON automation_proposal TYPE option<string>;
DEFINE FIELD disable_command    ON automation_proposal TYPE option<string>;
DEFINE FIELD failure_mode       ON automation_proposal TYPE option<string>;
    -- fail_open | fail_closed
DEFINE INDEX automation_proposal_uq ON automation_proposal FIELDS proposal UNIQUE;

-- ==== Typed evidence edges ====
-- Replaces the JSON-blob `evidence_refs` design that codex review flagged
-- as foreclosing the most important query: "which friction events have
-- not yet produced a proposal?" Heterogeneous source/target follows the
-- existing `derived_from` / `concerns` pattern (RELATION SCHEMAFULL).
-- `in` = proposal, `out` = the cited evidence record
-- (friction_event | command_outcome | skill_candidate |
--  hook_command_invocation | spawned | ...).
DEFINE TABLE cites_evidence TYPE RELATION SCHEMAFULL;
DEFINE FIELD count ON cites_evidence TYPE int DEFAULT 1;
DEFINE FIELD kind  ON cites_evidence TYPE option<string>;
DEFINE FIELD ts    ON cites_evidence TYPE datetime DEFAULT time::now();
DEFINE INDEX cites_evidence_in     ON cites_evidence FIELDS in;
DEFINE INDEX cites_evidence_out    ON cites_evidence FIELDS out;
DEFINE INDEX cites_evidence_in_out ON cites_evidence FIELDS in, out;

-- ==== Experiment (created on accept) ====
-- One row per accepted proposal. `artifact` is a typed link to the
-- created skill row when form=skill; `artifact_path` carries the
-- on-disk path for hook/guidance/automation forms. `scaffolded_at`
-- records when the CLI wrote the stub file (Phase C3 scaffold-on-accept
-- fix for the manual-step dropout problem).
DEFINE TABLE experiment SCHEMAFULL;
DEFINE FIELD proposal        ON experiment TYPE record<proposal> REFERENCE ON DELETE CASCADE;
DEFINE FIELD artifact        ON experiment TYPE option<record<skill>>;
DEFINE FIELD artifact_path   ON experiment TYPE option<string>;
DEFINE FIELD scaffolded_at   ON experiment TYPE option<datetime>;
DEFINE FIELD created_at      ON experiment TYPE datetime DEFAULT time::now();
DEFINE FIELD locked_verdict  ON experiment TYPE option<string>;
DEFINE FIELD status     ON experiment TYPE string  DEFAULT 'task_emitted';
-- task_emitted | scaffolded | regressed | retired
DEFINE FIELD task_path  ON experiment TYPE option<string>;
-- absolute path to .ax/tasks/<id>.md while pending
DEFINE INDEX experiment_status_idx ON experiment FIELDS status;
DEFINE INDEX experiment_proposal_uq ON experiment FIELDS proposal UNIQUE;
DEFINE INDEX experiment_created     ON experiment FIELDS created_at;

-- ==== Opportunity (verdict denominator) ====
-- Each time a proposal's trigger pattern recurs after experiment.created_at,
-- emit one row. `was_addressed` flips true when the experiment's artifact
-- was invoked/applied near the match (per-form definition in the plan doc).
-- Verdict math at checkpoint time is `addressed / opportunities` per window.
-- Modeled as a RELATION (in = experiment, out = matched evidence record)
-- so the heterogeneous evidence target works the same way as cites_evidence.
DEFINE TABLE opportunity TYPE RELATION SCHEMAFULL;
DEFINE FIELD matched_at    ON opportunity TYPE datetime;
DEFINE FIELD was_addressed ON opportunity TYPE bool DEFAULT false;
DEFINE INDEX opportunity_in_ts  ON opportunity FIELDS in, matched_at;
DEFINE INDEX opportunity_out    ON opportunity FIELDS out;

-- ==== Checkpoint (decision support, never auto-verdict) ====
-- One row per (experiment, kind) snapshot at +3 / +10 / +30 sessions
-- since experiment.created_at (see issue #83 - calendar days are the wrong
-- cadence when an agent ships eight sessions a day). Legacy day-based
-- rows (t+7 / t+30 / t+90) are preserved as historical data; the kind
-- field is a free-form string so the two cadences coexist.
-- `measured` is the aggregate {built, invoked, opportunities, addressed,
-- friction_delta}. `suggested` is the algorithm's verdict guess. The
-- human-confirmed `user_verdict` is what gets locked into experiment.
-- locked_verdict at +30s. Algorithm proposes, human decides.
DEFINE TABLE checkpoint SCHEMAFULL;
DEFINE FIELD experiment   ON checkpoint TYPE record<experiment> REFERENCE ON DELETE CASCADE;
DEFINE FIELD kind         ON checkpoint TYPE string;
    -- current: +3s | +10s | +30s | adhoc
    -- legacy:  t+7 | t+30 | t+90 (calendar-day windows, pre-#83)
DEFINE FIELD measured              ON checkpoint TYPE object;
DEFINE FIELD measured.opportunities ON checkpoint TYPE int DEFAULT 0;
DEFINE FIELD measured.addressed     ON checkpoint TYPE int DEFAULT 0;
DEFINE FIELD measured.ratio         ON checkpoint TYPE float DEFAULT 0;
DEFINE FIELD measured.built         ON checkpoint TYPE bool DEFAULT false;
-- Frequency disambiguation for opportunities=0 verdicts: if the cluster
-- frequency has grown since the proposal was accepted, the artifact is
-- being ignored (still firing). Otherwise the pattern self-resolved.
DEFINE FIELD measured.current_frequency  ON checkpoint TYPE option<int>;
DEFINE FIELD measured.baseline_frequency ON checkpoint TYPE option<int>;
DEFINE FIELD suggested    ON checkpoint TYPE option<string>;
    -- adopted | ignored | regressed | no_longer_needed | partial
DEFINE FIELD user_verdict ON checkpoint TYPE option<string>;
DEFINE FIELD observed_at  ON checkpoint TYPE datetime DEFAULT time::now();
DEFINE INDEX checkpoint_experiment_kind ON checkpoint FIELDS experiment, kind, observed_at;

-- ==== dogfood_run (Phase C12) ====
-- One row per dogfood scenario invocation. Owned by src/dogfood/wterm.ts.
DEFINE TABLE dogfood_run SCHEMAFULL;
DEFINE FIELD run_id           ON dogfood_run TYPE string;
DEFINE FIELD scenario         ON dogfood_run TYPE string;
DEFINE FIELD driver           ON dogfood_run TYPE string;       -- wterm | future drivers
DEFINE FIELD status           ON dogfood_run TYPE string;       -- passed | failed | error
DEFINE FIELD agent            ON dogfood_run TYPE option<string>;
DEFINE FIELD command          ON dogfood_run TYPE option<string>;
DEFINE FIELD command_source   ON dogfood_run TYPE option<string>;
DEFINE FIELD transport        ON dogfood_run TYPE option<string>;
DEFINE FIELD requested_transport ON dogfood_run TYPE option<string>;
DEFINE FIELD transport_fallback_reason ON dogfood_run TYPE option<string>;
DEFINE FIELD success_marker   ON dogfood_run TYPE option<string>;
DEFINE FIELD marker_found     ON dogfood_run TYPE bool DEFAULT false;
DEFINE FIELD timed_out        ON dogfood_run TYPE bool DEFAULT false;
DEFINE FIELD timeout_seconds  ON dogfood_run TYPE option<int>;
DEFINE FIELD transcript_artifact ON dogfood_run TYPE option<record<artifact>>;
DEFINE FIELD cwd              ON dogfood_run TYPE option<string>;
DEFINE FIELD started_at       ON dogfood_run TYPE datetime;
DEFINE FIELD ended_at         ON dogfood_run TYPE datetime;
DEFINE INDEX dogfood_run_id_uq      ON dogfood_run FIELDS run_id UNIQUE;
DEFINE INDEX dogfood_run_status_ts  ON dogfood_run FIELDS status, ended_at;
DEFINE INDEX dogfood_run_scenario   ON dogfood_run FIELDS scenario, ended_at;

-- =====================================================================
-- Phase B: retro table (2026-05-26)
-- =====================================================================
-- A structured reflection emitted by an agent at session-end. Four
-- canonical fields: tried (what the agent attempted), worked (what
-- landed), failed (what didn't), next (the experiment to run next).
-- See docs/language.md "retro" for the canonical definition.
--
-- Source enum:
--   claude_stop_hook   - Claude Code Stop hook ran `ax retro emit`
--   codex_rollout      - extracted from a Codex rollout summary
--   heuristic          - generated by ax from turn data (no LLM call)
--   manual             - user typed `ax retro emit --tried=... --worked=...`
--
-- One retro per session (UNIQUE index). Re-emitting overwrites; the raw
-- field preserves the original JSON for audit.
DEFINE TABLE retro SCHEMAFULL;
DEFINE FIELD session       ON retro TYPE record<session> REFERENCE ON DELETE CASCADE;
DEFINE FIELD source        ON retro TYPE string;
DEFINE FIELD tried         ON retro TYPE string;
DEFINE FIELD worked        ON retro TYPE option<string>;
DEFINE FIELD failed        ON retro TYPE option<string>;
DEFINE FIELD next          ON retro TYPE option<string>;
DEFINE FIELD raw           ON retro TYPE option<string>;        -- original JSON payload
DEFINE FIELD repository    ON retro TYPE option<record<repository>>;
DEFINE FIELD created_at    ON retro TYPE datetime DEFAULT time::now();
DEFINE INDEX retro_session_uq    ON retro FIELDS session UNIQUE;
DEFINE INDEX retro_source_ts     ON retro FIELDS source, created_at;
DEFINE INDEX retro_repository_ts ON retro FIELDS repository, created_at;

-- Graph edge: session got a retro. Lets queries traverse both directions
-- (session->reviewed->retro, retro<-reviewed<-session) and ask
-- `WHERE count(->reviewed) = 0` for the pending-retro queue powering
-- `ax retro pending`. Bidirectional + reads cleanly in English.
DEFINE TABLE reviewed TYPE RELATION FROM session TO retro SCHEMAFULL;
DEFINE FIELD created_at ON reviewed TYPE datetime DEFAULT time::now();
DEFINE INDEX reviewed_in_out_uq ON reviewed FIELDS in, out UNIQUE;

-- =====================================================================
-- ingest_file_state: per-source-file ingest watermark (2026-06-02)
-- =====================================================================
-- A cheap skip-unchanged marker for source transcript files. The Claude
-- transcript stage re-parses + re-writes every .jsonl in scope on every
-- run; the vast majority are unchanged between runs (the watcher fires
-- on a single new file but ingest re-scans the whole tree). This table
-- records, per file, the (mtime_ms, size) seen at last successful ingest.
--
-- On ingest the stage loads the whole table into a JS Map keyed by `path`
-- in ONE indexed read, statSyncs each candidate, and SKIPS parsing+writing
-- any file whose (mtime_ms, size) still matches the stored watermark. A
-- skipped file's turns/tool_calls/events are already in the DB from a prior
-- run, so skipping is output-equivalent. New/changed files always process,
-- then upsert their watermark. NEVER `NOT IN` - one indexed Map read only.
--
-- Record id = stableHash(path) (paths carry `/` etc. that are awkward in
-- record keys); `path` is stored as a field with a UNIQUE index so the
-- load query is a single indexed table scan.
DEFINE TABLE ingest_file_state SCHEMAFULL;
DEFINE FIELD path        ON ingest_file_state TYPE string;
DEFINE FIELD source_kind ON ingest_file_state TYPE string;       -- e.g. "claude_transcript"
DEFINE FIELD mtime_ms    ON ingest_file_state TYPE number;
DEFINE FIELD size        ON ingest_file_state TYPE number;
DEFINE FIELD ingested_at ON ingest_file_state TYPE datetime DEFAULT time::now();
DEFINE INDEX ingest_file_state_path_uq ON ingest_file_state FIELDS path UNIQUE;
DEFINE INDEX ingest_file_state_source  ON ingest_file_state FIELDS source_kind;
