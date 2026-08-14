-- ax cache schema v2 - DuckDB relational DDL.
--
-- This file replaces packages/schema/src/schema.surql. There is NO compatibility
-- path: no dual-write, no shadow read, no SurrealDB export or migration. An
-- existing install starts from scratch and re-ingests its transcripts.
--
-- WHAT THIS IS. The DuckDB cache is REBUILDABLE: every row here is derived from
-- files on disk (transcripts, git, skills, the OTLP spool) and can be dropped and
-- re-derived at any time. Durable judgment (proposals, verdicts, role tags, retros)
-- lives in the SQLite sidecar, not here.
--
-- ROW IDS. Every table is keyed by `id VARCHAR PRIMARY KEY`, a content hash of the
-- row's NATURAL KEY - source file identity plus provider-native ids and offsets.
-- Never an autoincrement, never a run id, never a wall-clock timestamp. See
-- packages/lib/src/stable-id.ts (`@ax/lib/stable-id`) for the contract and
-- NATURAL_KEY_RECIPES for what each table hashes. Re-deriving the same input
-- rewrites byte-identical ids, which is what lets sidecar refs survive a full
-- re-derive; packages/lib/src/cache-integrity.ts counts the refs that do not.
--
-- EDGES. Every Surreal RELATION table became a plain table with `in_id` / `out_id`
-- VARCHAR columns holding the endpoint row ids, indexed on both sides. `in` and
-- `out` are SQL keywords, so those two columns are the only renames in the whole
-- translation; every other table and column name is unchanged from schema.surql so
-- the reader/writer port stays mechanical.
--
-- POLYMORPHIC EDGES (P1-1). A Surreal `DEFINE TABLE x TYPE RELATION FROM a TO b`
-- edge is single-target: `in`/`out` always point at tables `a`/`b`, so the DuckDB
-- `in_id`/`out_id` VARCHAR carries enough information on its own (the reader
-- already knows which table to look the id up in). But `DEFINE TABLE x TYPE
-- RELATION SCHEMAFULL` with NO FROM/TO is untyped: Surreal's own record id
-- (`table:id`) carries the target table name inline, and readers such as
-- `type::table(out)` (apps/axctl/src/classifiers/facts.ts) depend on recovering
-- it. A bare DuckDB VARCHAR row id has no table prefix, so that information would
-- be silently lost on translation. THE RULE: every such untyped edge table gets an
-- explicit `in_table VARCHAR NOT NULL` and/or `out_table VARCHAR NOT NULL` column
-- (only for the side(s) that are actually polymorphic) recording the endpoint's
-- source table name, written alongside `in_id`/`out_id` by the same insert. The
-- eight Surreal `TYPE RELATION SCHEMAFULL` (no FROM/TO) tables this applies to:
--   * concerns, resulted_in, produced_artifact, has_artifact, derived_from,
--     cites_evidence - both `in` and `out` vary in real writers (or are reserved
--     generic evidence edges with no FROM/TO to narrow them) -> both columns.
--   * opportunity, telemetry_of - only `out` varies; every writer relates FROM a
--     hardcoded fixed table (`experiment:`, `session:` respectively), so only
--     `out_table` is added; adding a constant `in_table` would carry no
--     information.
--
-- REFERENCES. Reference columns keep their Surreal field name and hold the target
-- row's `id` as VARCHAR. There are deliberately NO FOREIGN KEY constraints: the
-- derive stages insert in whatever order the sources arrive, and a re-derive
-- rewrites tables independently. Referential integrity is a CHECK, not a
-- constraint - packages/lib/src/cache-integrity.ts.
--
-- TYPES. Surreal `datetime` -> TIMESTAMPTZ (== `TIMESTAMP WITH TIME ZONE`; DuckDB
-- accepts the short form as a real alias, not merely display sugar - see the
-- DuckDB timestamp docs). A plain `TIMESTAMP` silently drops the UTC offset Surreal
-- datetimes always carry (P2-1), so every datetime column in this file uses
-- TIMESTAMPTZ, never bare TIMESTAMP. `int` -> BIGINT, `float`/`number` -> DOUBLE,
-- `bool` -> BOOLEAN.
--
-- ARRAYS (P2-3). Surreal `array<T>` where T is a scalar (string/int/float/number/
-- bool/datetime) becomes a native DuckDB list column of the mapped element type
-- (`VARCHAR[]`, `BIGINT[]`, `DOUBLE[]`, `BOOLEAN[]`, `TIMESTAMPTZ[]`) - DuckDB lists
-- are a real first-class type, not a translation compromise, so there is no reason
-- to flatten a scalar array through JSON text. Everything else that is JSON in
-- Surreal - JSON-encoded object fields, arrays of records/objects, and any
-- `flexible`/nested-object shape (v3 has no `flexible<object>`) - stays VARCHAR and
-- is marked `-- JSON` at the column; still JSON text, readable with DuckDB's json
-- functions.
--
-- SEMANTICS (P2-2): `VALUE time::now()` cannot be expressed in DDL. Surreal's
-- `VALUE` clause OVERWRITES whatever the caller supplies, on every create AND every
-- update - it is not a fallback. A DuckDB `DEFAULT` only fires when an INSERT
-- omits the column outright, and does nothing at all on UPDATE. These three
-- columns used `VALUE time::now()` in schema.surql and therefore need the writer
-- (not the DDL default) to stamp `CURRENT_TIMESTAMP` on every write that touches
-- them, insert or update alike:
--   * skill.ingested_at
--   * skill_revision.ts
--   * agent_def.ingested_at
-- Every other `... DEFAULT CURRENT_TIMESTAMP` column below used Surreal `DEFAULT
-- time::now()` (a true default, honored only when the caller omits the field),
-- which DuckDB DEFAULT reproduces exactly - no writer discipline required there.
--
-- FULL-TEXT SEARCH. Not in this file. FTS indexes are BUILT AT INGEST, after the
-- rows land, because DuckDB's fts extension materializes an index table from the
-- current contents:
--     INSTALL fts; LOAD fts;
--     PRAGMA create_fts_index('turn',   'id', 'text_excerpt', overwrite = 1);
--     PRAGMA create_fts_index('commit', 'id', 'message',      overwrite = 1);
-- Those two surfaces - turn.text_excerpt and commit.message - are the WHOLE
-- covered set (what `ax recall` searches). The Surreal skill ngram FTS index
-- (`skill_search_name` / `skill_search_desc`, analyzer `skill_text` with
-- ngram(2, 8)) is DELIBERATELY DROPPED per issue #758: the skill catalogue is
-- small enough that skills search moves to plain SQL (ILIKE / list scan), and the
-- ngram index cost more to build than the scan it replaced. The Surreal
-- content_block search_text FTS is likewise not carried over; content-block search
-- is out of scope for this chunk.
--
-- OMITTED FROM THE TRANSLATION - each Surreal construct below has no DuckDB
-- counterpart here, and none of them is an oversight:
--   * DEFINE ANALYZER / FULLTEXT indexes - see FULL-TEXT SEARCH above; built at
--     ingest with PRAGMA create_fts_index, not declared in DDL.
--   * DEFINE BUCKET (transcripts, codex_artifacts) - v2 keeps blobs on disk under
--     the ax data dir, addressed by content hash; the database stores no blobs.
--   * REMOVE INDEX - those lines dropped legacy SurrealDB index state. A fresh
--     DuckDB cache has no legacy state to remove.
--   * REFERENCE ON DELETE CASCADE - cascade delete is a Surreal reference feature.
--     Here a re-derive rewrites whole tables, so cascades have nothing to do; the
--     affected columns carry a `-- was: REFERENCE ON DELETE CASCADE` note.
--
-- The manifest of every table below is packages/schema/src/duckdb-tables.ts.
-- Statements are idempotent (IF NOT EXISTS) so applying the file twice is a no-op.

CREATE TABLE IF NOT EXISTS skill (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    scope VARCHAR NOT NULL,  -- 'user' | 'project' | 'plugin:<id>' | 'agents-shared'
    dir_path VARCHAR NOT NULL,
    description VARCHAR,  -- parsed from frontmatter; body + raw frontmatter read from dir_path on demand
    content_hash VARCHAR NOT NULL,
    bytes BIGINT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ,  -- reconcile: stamped when present on disk
    deleted_at TIMESTAMPTZ  -- reconcile: soft tombstone when absent on disk
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_name_uq ON skill(name);
CREATE INDEX IF NOT EXISTS skill_scope ON skill(scope);

-- Append-only change log for skills: one row per *content change* (content_hash
-- flip) detected at ingest. The baseline is the current `skill` row; this table
-- captures drift over time so an edit to a skill (by the user OR an agent that
-- proactively rewrites it) leaves a tracked point to diff against. Written by
-- apps/axctl/src/ingest/skill-upsert.ts only when the hash differs.
CREATE TABLE IF NOT EXISTS skill_revision (
    id VARCHAR PRIMARY KEY,
    skill VARCHAR NOT NULL,  -- ref -> skill
    name VARCHAR NOT NULL,
    scope VARCHAR,
    content_hash VARCHAR NOT NULL,
    prev_hash VARCHAR,  -- null on 'added'
    bytes BIGINT,
    prev_bytes BIGINT,
    change VARCHAR NOT NULL,  -- 'added' | 'changed'
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS skill_revision_ts ON skill_revision(ts);
CREATE INDEX IF NOT EXISTS skill_revision_skill ON skill_revision(skill);

-- Agent definition files (`~/.claude/agents/*.md`, `<repo>/.claude/agents/*.md`).
-- Full graph entity with the same reconcile lifecycle as `skill` (see
-- apps/axctl/src/ingest/agent-def.ts + apps/axctl/src/agents/). The `skills`
-- list is the skill<->agent binding edited by `ax agents scope` / `ax skills scope`.
CREATE TABLE IF NOT EXISTS agent_def (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    scope VARCHAR NOT NULL,  -- 'user' | 'project'
    dir_path VARCHAR NOT NULL,
    description VARCHAR,
    model VARCHAR,
    skills VARCHAR[],  -- declared skills: frontmatter list (P2-3: native list, not JSON)
    content_hash VARCHAR NOT NULL,
    bytes BIGINT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_def_name_uq ON agent_def(name);
CREATE INDEX IF NOT EXISTS agent_def_scope ON agent_def(scope);

CREATE TABLE IF NOT EXISTS session (
    id VARCHAR PRIMARY KEY,
    project VARCHAR,
    cwd VARCHAR,
    model VARCHAR,
    reasoning_effort VARCHAR,  -- codex: turn_context effort (minimal|low|medium|high|xhigh, last seen); claude: settings.json effortLevel (high|medium|low), stamped only on sessions active at ingest time
    source VARCHAR NOT NULL DEFAULT 'claude',  -- 'claude' | 'codex'
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    raw_file VARCHAR,  -- f"transcripts:/<id>.jsonl" pointer; full original jsonl
    labels VARCHAR,  -- JSON string[]; e.g. ["spar"]; spar-score stamps variant sessions
    repository VARCHAR,  -- ref -> repository
    checkout VARCHAR,  -- ref -> checkout
    workspace VARCHAR  -- ref -> workspace
);
CREATE INDEX IF NOT EXISTS session_repository_started ON session(repository, started_at);
CREATE INDEX IF NOT EXISTS session_checkout_started ON session(checkout, started_at);
CREATE INDEX IF NOT EXISTS session_workspace_started ON session(workspace, started_at);
-- Standalone started_at index: the dashboard roots query orders all sessions
-- by started_at with no repository/checkout/workspace prefix, so the composite
-- indexes above don't cover it. See GitHub issue #76.
CREATE INDEX IF NOT EXISTS session_started ON session(started_at);

-- Metadata-only Claude Code sidecar artifacts under .claude/projects/<project>/.
-- Stores bounded file metadata and hashes only; never raw paste/image caches,
-- raw API bodies, absolute home paths, or large tool-result bodies.
CREATE TABLE IF NOT EXISTS claude_sidecar_artifact (
    id VARCHAR PRIMARY KEY,
    kind VARCHAR NOT NULL,
    project VARCHAR NOT NULL,
    safe_relative_path VARCHAR NOT NULL,
    path_hash VARCHAR NOT NULL,
    size BIGINT NOT NULL,
    mtime TIMESTAMPTZ NOT NULL,
    content_hash VARCHAR,
    session VARCHAR,  -- ref -> session
    relation_ids_json VARCHAR,
    relation_attrs_json VARCHAR,
    observed_at TIMESTAMPTZ NOT NULL,
    excerpt VARCHAR,
    attrs_json VARCHAR
);
CREATE UNIQUE INDEX IF NOT EXISTS claude_sidecar_artifact_path_hash ON claude_sidecar_artifact(path_hash);
CREATE INDEX IF NOT EXISTS claude_sidecar_artifact_session ON claude_sidecar_artifact(session);
CREATE INDEX IF NOT EXISTS claude_sidecar_artifact_kind_project ON claude_sidecar_artifact(kind, project);

-- Tool calls that produced or later inspected Claude Code sidecar artifacts.
-- Stores the graph edge and bounded structured facts only; absolute sidecar
-- paths and raw large outputs stay out of the DB.
CREATE TABLE IF NOT EXISTS used_sidecar_artifact (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    session VARCHAR,  -- ref -> session
    action VARCHAR NOT NULL,  -- produced | read | searched | inspected
    source VARCHAR NOT NULL,  -- output_excerpt | read_input | command_text
    sidecar_kind VARCHAR NOT NULL,
    path_hash VARCHAR NOT NULL,
    command_tool VARCHAR,
    pattern VARCHAR,
    "offset" BIGINT,
    "limit" BIGINT,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS used_sidecar_artifact_in ON used_sidecar_artifact(in_id);
CREATE INDEX IF NOT EXISTS used_sidecar_artifact_out ON used_sidecar_artifact(out_id);
CREATE INDEX IF NOT EXISTS used_sidecar_artifact_session_action ON used_sidecar_artifact(session, action);

CREATE TABLE IF NOT EXISTS agent_provider (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    display_name VARCHAR NOT NULL,
    version VARCHAR,
    capabilities VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_provider_name_uq ON agent_provider(name);

CREATE TABLE IF NOT EXISTS agent_model (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    provider VARCHAR NOT NULL,
    display_name VARCHAR NOT NULL,
    input_per_million_usd DOUBLE,
    output_per_million_usd DOUBLE,
    cache_creation_per_million_usd DOUBLE,
    cache_read_per_million_usd DOUBLE,
    input_above_200k_per_million_usd DOUBLE,
    output_above_200k_per_million_usd DOUBLE,
    cache_creation_above_200k_per_million_usd DOUBLE,
    cache_read_above_200k_per_million_usd DOUBLE,
    fast_multiplier DOUBLE,
    context_window BIGINT,
    pricing_source VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_model_name_uq ON agent_model(name);
CREATE INDEX IF NOT EXISTS agent_model_provider ON agent_model(provider);

CREATE TABLE IF NOT EXISTS agent_session (
    id VARCHAR PRIMARY KEY,
    provider VARCHAR NOT NULL,  -- ref -> agent_provider
    provider_session_id VARCHAR NOT NULL,
    ax_session VARCHAR,  -- ref -> session
    cwd VARCHAR,
    project VARCHAR,
    title VARCHAR,
    model VARCHAR,
    source_path VARCHAR,
    raw VARCHAR,  -- JSON-encoded
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_session_provider_id ON agent_session(provider, provider_session_id);
CREATE INDEX IF NOT EXISTS agent_session_ax_session ON agent_session(ax_session);

CREATE TABLE IF NOT EXISTS agent_event (
    id VARCHAR PRIMARY KEY,
    agent_session VARCHAR NOT NULL,  -- ref -> agent_session
    ax_session VARCHAR,  -- ref -> session
    provider VARCHAR NOT NULL,  -- ref -> agent_provider
    provider_event_id VARCHAR,
    parent_provider_event_id VARCHAR,
    seq BIGINT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    type VARCHAR NOT NULL,
    role VARCHAR,
    text VARCHAR,
    text_excerpt VARCHAR,
    raw VARCHAR,  -- JSON-encoded
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR  -- JSON-encoded
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_event_session_seq ON agent_event(agent_session, seq);
CREATE INDEX IF NOT EXISTS agent_event_provider_id ON agent_event(provider, provider_event_id);
CREATE INDEX IF NOT EXISTS agent_event_session_ts ON agent_event(agent_session, ts);

CREATE TABLE IF NOT EXISTS turn (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session; was: REFERENCE ON DELETE CASCADE
    agent_event VARCHAR,  -- ref -> agent_event
    seq BIGINT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    role VARCHAR NOT NULL,  -- 'user' | 'assistant' | 'tool_result'
    message_kind VARCHAR,  -- 'task' | 'context' | 'control' | 'tool_result' | 'system_or_developer' | 'assistant' | 'tool_call'
    intent_kind VARCHAR,  -- 'organic_task' | 'correction' | 'preference' | 'wrapper_instruction' | ...
    text VARCHAR,  -- full extracted message text for analysis
    text_excerpt VARCHAR,  -- first ~500 chars
    has_tool_use BOOLEAN NOT NULL DEFAULT FALSE,
    has_error BOOLEAN NOT NULL DEFAULT FALSE,
    thinking_blocks BIGINT,  -- count of thinking + redacted_thinking content blocks (claude assistant turns)
    thinking_tokens BIGINT  -- output_tokens of thinking-only assistant turns (transcripts strip thinking text, so the thinking-only event's own usage is the measurable signal; mixed turns read 0 = lower bound)
);
CREATE UNIQUE INDEX IF NOT EXISTS turn_session_seq ON turn(session, seq);
CREATE INDEX IF NOT EXISTS turn_ts ON turn(ts);
CREATE INDEX IF NOT EXISTS turn_agent_event ON turn(agent_event);

CREATE TABLE IF NOT EXISTS file (
    id VARCHAR PRIMARY KEY,
    repo VARCHAR,
    path VARCHAR NOT NULL,
    lang VARCHAR,
    repository VARCHAR,  -- ref -> repository
    checkout VARCHAR,  -- ref -> checkout
    workspace VARCHAR,  -- ref -> workspace
    kind VARCHAR,
    identity_scope VARCHAR
);
CREATE UNIQUE INDEX IF NOT EXISTS file_path_uq ON file(repo, path);
CREATE INDEX IF NOT EXISTS file_path ON file(path);
CREATE INDEX IF NOT EXISTS file_repository_path ON file(repository, path);
CREATE INDEX IF NOT EXISTS file_workspace_path ON file(workspace, path);

CREATE TABLE IF NOT EXISTS symbol (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    kind VARCHAR,  -- 'camel' | 'snake' | 'function' | ...
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS symbol_name_uq ON symbol(name);

CREATE TABLE IF NOT EXISTS error_signature (
    id VARCHAR PRIMARY KEY,
    text VARCHAR NOT NULL,
    normalized VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS error_signature_norm_uq ON error_signature(normalized);

CREATE TABLE IF NOT EXISTS "commit" (
    id VARCHAR PRIMARY KEY,
    sha VARCHAR NOT NULL,
    repo VARCHAR NOT NULL,
    message VARCHAR,
    author VARCHAR,
    ts TIMESTAMPTZ NOT NULL,
    repository VARCHAR,  -- ref -> repository
    checkout VARCHAR,  -- ref -> checkout
    -- option<bool>, not bool DEFAULT false: the git stage re-UPSERTs commits via
    -- CONTENT (omitting `reverted`), and pre-existing rows predate the field, so a
    -- non-optional bool coerces NONE → ingest crash (schema-orphan-field-none-crash).
    -- NONE means "not known reverted"; durability counts only `reverted = true`.
    reverted BOOLEAN
);
CREATE UNIQUE INDEX IF NOT EXISTS commit_sha_uq ON "commit"(repo, sha);
CREATE INDEX IF NOT EXISTS commit_repository_ts ON "commit"(repository, ts);
CREATE INDEX IF NOT EXISTS commit_reverted ON "commit"(reverted);

CREATE TABLE IF NOT EXISTS repository (
    id VARCHAR PRIMARY KEY,
    name VARCHAR,
    remote_url VARCHAR,
    root_path VARCHAR,
    initial_commit VARCHAR,
    default_branch VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS repository_remote ON repository(remote_url);
CREATE INDEX IF NOT EXISTS repository_initial_commit ON repository(initial_commit);

CREATE TABLE IF NOT EXISTS checkout (
    id VARCHAR PRIMARY KEY,
    repository VARCHAR NOT NULL,  -- ref -> repository
    path VARCHAR NOT NULL,
    branch VARCHAR,
    head_sha VARCHAR,
    worktree_name VARCHAR,
    dirty BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_path_uq ON checkout(repository, path);

CREATE TABLE IF NOT EXISTS workspace (
    id VARCHAR PRIMARY KEY,
    repository VARCHAR,  -- ref -> repository
    checkout VARCHAR,  -- ref -> checkout
    root_path VARCHAR NOT NULL,
    name VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tool (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    provider VARCHAR,
    identity VARCHAR,
    kind VARCHAR,
    labels VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_identity_uq ON tool(provider, name, identity);

CREATE TABLE IF NOT EXISTS tool_call (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    agent_event VARCHAR,  -- ref -> agent_event
    turn VARCHAR,  -- ref -> turn
    tool VARCHAR,  -- ref -> tool
    name VARCHAR NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    status VARCHAR,
    input_json VARCHAR,  -- JSON-encoded
    output_json VARCHAR,  -- JSON-encoded
    raw VARCHAR,  -- JSON-encoded
    duration_ms BIGINT,
    seq BIGINT,
    call_id VARCHAR,
    cwd VARCHAR,
    command_text VARCHAR,
    command_norm VARCHAR,
    command_tool VARCHAR,  -- ref -> tool
    output_excerpt VARCHAR,
    error_text VARCHAR,
    exit_code BIGINT,
    has_error BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS tool_call_session_ts ON tool_call(session, ts);
CREATE INDEX IF NOT EXISTS tool_call_tool_ts ON tool_call(tool, ts);
CREATE INDEX IF NOT EXISTS tool_call_command_norm_ts ON tool_call(command_norm, ts);
CREATE INDEX IF NOT EXISTS tool_call_command_tool_ts ON tool_call(command_tool, ts);
CREATE INDEX IF NOT EXISTS tool_call_error_ts ON tool_call(has_error, ts);
CREATE INDEX IF NOT EXISTS tool_call_agent_event ON tool_call(agent_event);

-- Content-type classification of tool_call outputs (derive-content-types stage).
-- Closed taxonomy; one node per category. See content-type-classify.ts.
CREATE TABLE IF NOT EXISTS content_type (
    id VARCHAR PRIMARY KEY,
    category VARCHAR NOT NULL,
    label VARCHAR NOT NULL
);

-- has_content: tool_call -> content_type. Denormalizes session + bytes so every
-- downstream rollup is deref-free (house idiom; derefs in aggregates hang prod).
CREATE TABLE IF NOT EXISTS has_content (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    method VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL DEFAULT 1.0,
    fine_label VARCHAR,
    bytes BIGINT NOT NULL DEFAULT 0,
    session VARCHAR,  -- ref -> session
    ts TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS has_content_in ON has_content(in_id);
CREATE INDEX IF NOT EXISTS has_content_out ON has_content(out_id);
CREATE INDEX IF NOT EXISTS has_content_session ON has_content(session);

CREATE TABLE IF NOT EXISTS plan (
    id VARCHAR PRIMARY KEY,
    session VARCHAR,  -- ref -> session
    source VARCHAR,
    title VARCHAR,
    summary VARCHAR,
    status VARCHAR,
    items VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS plan_session ON plan(session);
CREATE INDEX IF NOT EXISTS plan_source_session ON plan(source, session);

CREATE TABLE IF NOT EXISTS plan_item (
    id VARCHAR PRIMARY KEY,
    plan VARCHAR NOT NULL,  -- ref -> plan
    external_id VARCHAR,
    seq BIGINT NOT NULL,
    text VARCHAR NOT NULL,
    active_form VARCHAR,
    status VARCHAR,
    raw VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS plan_item_plan_seq ON plan_item(plan, seq);

CREATE TABLE IF NOT EXISTS artifact (
    id VARCHAR PRIMARY KEY,
    kind VARCHAR NOT NULL,
    title VARCHAR,
    uri VARCHAR,
    path VARCHAR,
    content_hash VARCHAR,
    raw VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS artifact_hash ON artifact(content_hash);

CREATE TABLE IF NOT EXISTS content_document (
    id VARCHAR PRIMARY KEY,
    source_kind VARCHAR NOT NULL,
    source_ref VARCHAR,
    turn VARCHAR,  -- ref -> turn
    session VARCHAR,  -- ref -> session
    agent_event VARCHAR,  -- ref -> agent_event
    skill VARCHAR,  -- ref -> skill
    artifact VARCHAR,  -- ref -> artifact
    plan_snapshot VARCHAR,  -- ref -> plan_snapshot
    path VARCHAR,
    uri VARCHAR,
    title VARCHAR,
    content_hash VARCHAR NOT NULL,
    parse_fingerprint VARCHAR NOT NULL,
    registry_version VARCHAR NOT NULL,
    parser_id VARCHAR NOT NULL,
    parser_version VARCHAR NOT NULL,
    classifier_versions VARCHAR,
    blockset_hash VARCHAR,
    raw_text VARCHAR,
    raw VARCHAR,
    labels VARCHAR,
    metrics VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS content_document_source ON content_document(source_kind, source_ref);
CREATE INDEX IF NOT EXISTS content_document_hash ON content_document(content_hash);
CREATE INDEX IF NOT EXISTS content_document_parse ON content_document(parse_fingerprint);
-- Resolve a session's turn documents (share export / inspector). Without this,
-- `WHERE source_kind='turn' AND session=$sid` only uses the source_kind prefix
-- and scans every turn document (~600ms/session); the composite makes it ~0.3ms.
CREATE INDEX IF NOT EXISTS content_document_session ON content_document(session, source_kind);

CREATE TABLE IF NOT EXISTS content_block (
    id VARCHAR PRIMARY KEY,
    document VARCHAR NOT NULL,  -- ref -> content_document; was: REFERENCE ON DELETE CASCADE
    source_kind VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    seq BIGINT NOT NULL,
    parent_seq BIGINT,
    role VARCHAR,
    heading VARCHAR,
    text VARCHAR,
    text_excerpt VARCHAR,
    search_text VARCHAR,
    block_hash VARCHAR NOT NULL,
    start_offset BIGINT,
    end_offset BIGINT,
    confidence DOUBLE NOT NULL DEFAULT 1.0,
    parser VARCHAR NOT NULL,
    raw VARCHAR,
    labels VARCHAR,
    metrics VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS content_block_document_seq ON content_block(document, seq);
CREATE INDEX IF NOT EXISTS content_block_kind ON content_block(kind, ts);
CREATE INDEX IF NOT EXISTS content_block_hash ON content_block(document, block_hash);
CREATE TABLE IF NOT EXISTS content_atom (
    id VARCHAR PRIMARY KEY,
    block VARCHAR NOT NULL,  -- ref -> content_block; was: REFERENCE ON DELETE CASCADE
    document VARCHAR NOT NULL,  -- ref -> content_document
    source_kind VARCHAR NOT NULL,
    session VARCHAR,  -- ref -> session
    agent_session VARCHAR,  -- ref -> agent_session
    repository VARCHAR,  -- ref -> repository
    workspace VARCHAR,  -- ref -> workspace
    artifact_kind VARCHAR,
    kind VARCHAR NOT NULL,
    value VARCHAR NOT NULL,
    normalized VARCHAR,
    start_offset BIGINT,
    end_offset BIGINT,
    confidence DOUBLE NOT NULL DEFAULT 1.0,
    raw VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS content_atom_kind_value ON content_atom(kind, normalized);
CREATE INDEX IF NOT EXISTS content_atom_block ON content_atom(block);
CREATE INDEX IF NOT EXISTS content_atom_document_kind ON content_atom(document, kind);
CREATE INDEX IF NOT EXISTS content_atom_source_kind_value ON content_atom(source_kind, kind, normalized);
CREATE INDEX IF NOT EXISTS content_atom_session_kind ON content_atom(session, kind);
CREATE INDEX IF NOT EXISTS content_atom_workspace_kind_value ON content_atom(workspace, kind, normalized);

CREATE TABLE IF NOT EXISTS mentions_file (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    document VARCHAR NOT NULL,  -- ref -> content_document
    block VARCHAR NOT NULL,  -- ref -> content_block
    confidence DOUBLE NOT NULL DEFAULT 1.0,
    source_kind VARCHAR NOT NULL,
    workspace VARCHAR,  -- ref -> workspace
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mentions_file_in ON mentions_file(in_id);
CREATE INDEX IF NOT EXISTS mentions_file_out ON mentions_file(out_id);
CREATE INDEX IF NOT EXISTS mentions_file_document ON mentions_file(document);

CREATE TABLE IF NOT EXISTS mentions_commit (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    document VARCHAR NOT NULL,  -- ref -> content_document
    block VARCHAR NOT NULL,  -- ref -> content_block
    confidence DOUBLE NOT NULL DEFAULT 1.0,
    source_kind VARCHAR NOT NULL,
    workspace VARCHAR,  -- ref -> workspace
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mentions_commit_in ON mentions_commit(in_id);
CREATE INDEX IF NOT EXISTS mentions_commit_out ON mentions_commit(out_id);

CREATE TABLE IF NOT EXISTS mentions_artifact (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    document VARCHAR NOT NULL,  -- ref -> content_document
    block VARCHAR NOT NULL,  -- ref -> content_block
    confidence DOUBLE NOT NULL DEFAULT 1.0,
    source_kind VARCHAR NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mentions_artifact_in ON mentions_artifact(in_id);
CREATE INDEX IF NOT EXISTS mentions_artifact_out ON mentions_artifact(out_id);

CREATE TABLE IF NOT EXISTS plan_snapshot (
    id VARCHAR PRIMARY KEY,
    plan VARCHAR,  -- ref -> plan
    session VARCHAR,  -- ref -> session
    tool_call VARCHAR,  -- ref -> tool_call
    agent_event VARCHAR,  -- ref -> agent_event
    source VARCHAR,
    items VARCHAR NOT NULL,  -- JSON-encoded
    summary VARCHAR,
    explanation VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS plan_snapshot_plan_ts ON plan_snapshot(plan, ts);
CREATE INDEX IF NOT EXISTS plan_snapshot_agent_event ON plan_snapshot(agent_event);

CREATE TABLE IF NOT EXISTS compaction (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    agent_event VARCHAR,  -- ref -> agent_event
    harness VARCHAR NOT NULL,  -- provider name: claude|codex|pi|cursor|opencode
    ts TIMESTAMPTZ NOT NULL,
    trigger VARCHAR,  -- auto|manual|hook
    strategy VARCHAR NOT NULL,  -- summarize|history_replacement|encrypted
    source_confidence VARCHAR NOT NULL,  -- explicit|derived
    summary VARCHAR,  -- Pi/Claude; null for Codex/Cursor
    tokens_before BIGINT,
    boundary_ref VARCHAR,  -- where post-compaction history resumes
    kept_count BIGINT,  -- Codex replacement_history length
    read_files VARCHAR,  -- JSON-encoded array; Pi details
    modified_files VARCHAR,  -- JSON-encoded array; Pi details
    raw VARCHAR  -- JSON-encoded
);
CREATE INDEX IF NOT EXISTS compaction_session_ts ON compaction(session, ts);
CREATE INDEX IF NOT EXISTS compaction_agent_event ON compaction(agent_event);

CREATE TABLE IF NOT EXISTS insight (
    id VARCHAR PRIMARY KEY,
    subject_type VARCHAR NOT NULL,
    subject_id VARCHAR,
    kind VARCHAR,
    text VARCHAR NOT NULL,
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS insight_subject ON insight(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS friction_event (
    id VARCHAR PRIMARY KEY,
    session VARCHAR,  -- ref -> session
    turn VARCHAR,  -- ref -> turn
    kind VARCHAR NOT NULL,
    text VARCHAR,
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    raw VARCHAR,  -- JSON-encoded
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS friction_session_kind ON friction_event(session, kind);

CREATE TABLE IF NOT EXISTS turn_analysis (
    id VARCHAR PRIMARY KEY,
    turn VARCHAR NOT NULL,  -- ref -> turn; was: REFERENCE ON DELETE CASCADE
    session VARCHAR,  -- ref -> session
    speaker VARCHAR NOT NULL,
    act VARCHAR NOT NULL,
    sentiment VARCHAR NOT NULL,
    polarity VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL,
    method VARCHAR NOT NULL,
    signals VARCHAR,  -- JSON-encoded
    text VARCHAR,
    ts TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS turn_analysis_turn ON turn_analysis(turn);
CREATE INDEX IF NOT EXISTS turn_analysis_session_act ON turn_analysis(session, act);
CREATE INDEX IF NOT EXISTS turn_analysis_polarity_ts ON turn_analysis(polarity, ts);

CREATE TABLE IF NOT EXISTS reaction_event (
    id VARCHAR PRIMARY KEY,
    user_turn VARCHAR NOT NULL,  -- ref -> turn; was: REFERENCE ON DELETE CASCADE
    assistant_turn VARCHAR,  -- ref -> turn
    session VARCHAR,  -- ref -> session
    reaction_type VARCHAR NOT NULL,
    target VARCHAR NOT NULL,
    polarity VARCHAR NOT NULL,
    durability VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL,
    method VARCHAR NOT NULL,
    signals VARCHAR,  -- JSON-encoded
    user_text VARCHAR,
    assistant_text VARCHAR,
    context_json VARCHAR,  -- JSON-encoded
    ts TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS reaction_event_user_turn ON reaction_event(user_turn);
CREATE INDEX IF NOT EXISTS reaction_event_session_ts ON reaction_event(session, ts);
CREATE INDEX IF NOT EXISTS reaction_event_theme ON reaction_event(reaction_type, target, durability);

CREATE TABLE IF NOT EXISTS classifier_definition (
    id VARCHAR PRIMARY KEY,
    classifier_key VARCHAR NOT NULL,
    version VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    description VARCHAR NOT NULL,
    input VARCHAR NOT NULL,
    labels VARCHAR NOT NULL,  -- JSON-encoded
    targets VARCHAR NOT NULL,  -- JSON-encoded
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS classifier_definition_key_version ON classifier_definition(classifier_key, version);

CREATE TABLE IF NOT EXISTS classifier_run (
    id VARCHAR PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    status VARCHAR NOT NULL,
    classifier_keys VARCHAR NOT NULL,  -- JSON-encoded
    since_days BIGINT,
    window_count BIGINT NOT NULL,
    result_count BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS classifier_run_started ON classifier_run(started_at);

CREATE TABLE IF NOT EXISTS classifier_result (
    id VARCHAR PRIMARY KEY,
    classifier_definition VARCHAR NOT NULL,  -- ref -> classifier_definition; was: REFERENCE ON DELETE CASCADE
    classifier_run VARCHAR,  -- ref -> classifier_run
    classifier_key VARCHAR NOT NULL,
    classifier_version VARCHAR NOT NULL,
    subject_type VARCHAR NOT NULL,
    subject_id VARCHAR NOT NULL,
    session VARCHAR,  -- ref -> session
    turn VARCHAR,  -- ref -> turn
    label VARCHAR NOT NULL,
    target VARCHAR NOT NULL,
    polarity VARCHAR NOT NULL,
    durability VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL,
    method VARCHAR NOT NULL,
    evidence_json VARCHAR NOT NULL,
    signals VARCHAR,  -- JSON-encoded
    ts TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS classifier_result_classifier ON classifier_result(classifier_key, classifier_version);
CREATE INDEX IF NOT EXISTS classifier_result_turn ON classifier_result(turn);
CREATE INDEX IF NOT EXISTS classifier_result_theme ON classifier_result(classifier_key, label, target, durability);

CREATE TABLE IF NOT EXISTS classifier_graph_node (
    id VARCHAR PRIMARY KEY,
    graph_id VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    label VARCHAR NOT NULL,
    properties_json VARCHAR NOT NULL,
    source_kind VARCHAR NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS classifier_graph_node_graph_id ON classifier_graph_node(graph_id);
CREATE INDEX IF NOT EXISTS classifier_graph_node_kind ON classifier_graph_node(kind);

CREATE TABLE IF NOT EXISTS classifier_graph_edge (
    id VARCHAR PRIMARY KEY,
    graph_id VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    from_id VARCHAR NOT NULL,
    to_id VARCHAR NOT NULL,
    evidence_path VARCHAR NOT NULL,
    properties_json VARCHAR NOT NULL,
    source_kind VARCHAR NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS classifier_graph_edge_graph_id ON classifier_graph_edge(graph_id);
CREATE INDEX IF NOT EXISTS classifier_graph_edge_kind ON classifier_graph_edge(kind);
CREATE INDEX IF NOT EXISTS classifier_graph_edge_from ON classifier_graph_edge(from_id);
CREATE INDEX IF NOT EXISTS classifier_graph_edge_to ON classifier_graph_edge(to_id);

CREATE TABLE IF NOT EXISTS classifier_graph_fact (
    id VARCHAR PRIMARY KEY,
    graph_id VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    subject VARCHAR NOT NULL,
    predicate VARCHAR NOT NULL,
    object VARCHAR,
    value_json VARCHAR,
    evidence_edges_json VARCHAR NOT NULL,
    properties_json VARCHAR NOT NULL,
    source_kind VARCHAR NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS classifier_graph_fact_graph_id ON classifier_graph_fact(graph_id);
CREATE INDEX IF NOT EXISTS classifier_graph_fact_kind ON classifier_graph_fact(kind);
CREATE INDEX IF NOT EXISTS classifier_graph_fact_subject ON classifier_graph_fact(subject);
CREATE INDEX IF NOT EXISTS classifier_graph_fact_theme ON classifier_graph_fact(kind, predicate);

-- Transcript label-mining: reviewed-status rows and embedding/vector rows.
-- Graph facts themselves reuse classifier_graph_* (node/edge/fact); these two
-- tables hold the reviewed-status provenance and the vector refs that join
-- candidates back to promotion-safe graph facts. Writes are idempotent (UPSERT
-- keyed by candidate_id / vector id).
CREATE TABLE IF NOT EXISTS transcript_label_review (
    id VARCHAR PRIMARY KEY,
    candidate_id VARCHAR NOT NULL,
    graph_fact_id VARCHAR,
    label_family VARCHAR NOT NULL,
    review_status VARCHAR NOT NULL,
    promotion_safe BOOLEAN NOT NULL,
    reviewed_label VARCHAR,
    reviewed_target VARCHAR,
    reviewer VARCHAR NOT NULL,
    rationale VARCHAR NOT NULL,
    evidence_paths_json VARCHAR NOT NULL,  -- JSON-encoded
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS transcript_label_review_candidate ON transcript_label_review(candidate_id);
CREATE INDEX IF NOT EXISTS transcript_label_review_graph_fact ON transcript_label_review(graph_fact_id);
CREATE INDEX IF NOT EXISTS transcript_label_review_family ON transcript_label_review(label_family);
CREATE INDEX IF NOT EXISTS transcript_label_review_status ON transcript_label_review(review_status);

CREATE TABLE IF NOT EXISTS transcript_label_vector (
    id VARCHAR PRIMARY KEY,
    candidate_id VARCHAR NOT NULL,
    graph_fact_id VARCHAR,
    embedding_model VARCHAR NOT NULL,
    embedding_dim BIGINT NOT NULL,
    embedding_ref VARCHAR NOT NULL,
    nearest_reviewed_candidate_ids_json VARCHAR NOT NULL,  -- JSON-encoded
    nearest_scores_json VARCHAR NOT NULL,  -- JSON-encoded
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS transcript_label_vector_candidate ON transcript_label_vector(candidate_id);
CREATE INDEX IF NOT EXISTS transcript_label_vector_graph_fact ON transcript_label_vector(graph_fact_id);
CREATE INDEX IF NOT EXISTS transcript_label_vector_model ON transcript_label_vector(embedding_model);

CREATE TABLE IF NOT EXISTS semantic_signal (
    id VARCHAR PRIMARY KEY,
    kind VARCHAR NOT NULL,
    label VARCHAR NOT NULL,
    canonical_text VARCHAR NOT NULL,
    description VARCHAR,
    method VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    metrics VARCHAR  -- JSON-encoded
);
CREATE UNIQUE INDEX IF NOT EXISTS semantic_signal_kind_label ON semantic_signal(kind, label);

CREATE TABLE IF NOT EXISTS diagnostic_event (
    id VARCHAR PRIMARY KEY,
    session VARCHAR,  -- ref -> session
    turn VARCHAR,  -- ref -> turn
    kind VARCHAR NOT NULL,
    status VARCHAR,
    text VARCHAR,
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    raw VARCHAR,  -- JSON-encoded
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS diagnostic_session_kind ON diagnostic_event(session, kind);

CREATE TABLE IF NOT EXISTS guidance (
    id VARCHAR PRIMARY KEY,
    slug VARCHAR NOT NULL,
    title VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'active',
    labels VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_slug_uq ON guidance(slug);
CREATE INDEX IF NOT EXISTS guidance_status ON guidance(status);

CREATE TABLE IF NOT EXISTS guidance_version (
    id VARCHAR PRIMARY KEY,
    guidance VARCHAR NOT NULL,  -- ref -> guidance
    version VARCHAR NOT NULL,
    text VARCHAR NOT NULL,
    raw VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR NOT NULL DEFAULT 'proposed',
    scope VARCHAR,
    risk VARCHAR,
    evidence VARCHAR,
    metrics_before VARCHAR,
    metrics_after VARCHAR
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_version_uq ON guidance_version(guidance, version);
CREATE INDEX IF NOT EXISTS guidance_version_status ON guidance_version(status, created_at);

CREATE TABLE IF NOT EXISTS guidance_source (
    id VARCHAR PRIMARY KEY,
    path VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    scope VARCHAR NOT NULL,
    provider VARCHAR NOT NULL,
    evidence_strength VARCHAR NOT NULL,
    git_root VARCHAR,
    tracked BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_source_path_uq ON guidance_source(path);
CREATE INDEX IF NOT EXISTS guidance_source_scope ON guidance_source(scope, provider);

CREATE TABLE IF NOT EXISTS guidance_revision (
    id VARCHAR PRIMARY KEY,
    source VARCHAR,  -- ref -> guidance_source
    source_path VARCHAR NOT NULL,
    scope VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    prev_hash VARCHAR,
    bytes BIGINT,
    prev_bytes BIGINT,
    change VARCHAR,
    evidence_strength VARCHAR NOT NULL,
    commit_evidence VARCHAR,
    file_evidence VARCHAR,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_revision_source_hash ON guidance_revision(source_path, content_hash);
CREATE INDEX IF NOT EXISTS guidance_revision_scope ON guidance_revision(scope, observed_at);

-- Provider-compatible metadata inventory for guidance/config artifacts.
-- Safe-by-default: stores hashes, counts, event/server/key names, and redacted
-- coarse paths only. Never raw file bodies, env values, hook commands,
-- permission patterns, memory text, or absolute home paths.
CREATE TABLE IF NOT EXISTS guidance_config_artifact (
    id VARCHAR PRIMARY KEY,
    provider VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    scope VARCHAR NOT NULL,
    safe_path VARCHAR NOT NULL,
    path_hash VARCHAR NOT NULL,
    authority_kind VARCHAR NOT NULL,
    authority_hash VARCHAR NOT NULL,
    content_hash VARCHAR,
    parse_status VARCHAR NOT NULL,
    bytes BIGINT NOT NULL,
    token_estimate BIGINT NOT NULL,
    command_hashes_json VARCHAR,
    hook_event_names_json VARCHAR,
    matcher_count BIGINT NOT NULL,
    mcp_server_names_json VARCHAR,
    env_keys_json VARCHAR,
    enabled_tool_count BIGINT,
    model VARCHAR,
    reasoning_effort VARCHAR,
    output_style VARCHAR,
    permission_allow_count BIGINT NOT NULL,
    permission_ask_count BIGINT NOT NULL,
    permission_deny_count BIGINT NOT NULL,
    metadata_json VARCHAR,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_config_artifact_path_hash ON guidance_config_artifact(provider, path_hash);
CREATE INDEX IF NOT EXISTS guidance_config_artifact_kind_scope ON guidance_config_artifact(provider, kind, scope);
CREATE INDEX IF NOT EXISTS guidance_config_artifact_authority ON guidance_config_artifact(provider, authority_hash);
CREATE INDEX IF NOT EXISTS guidance_config_artifact_parse_status ON guidance_config_artifact(parse_status);

CREATE TABLE IF NOT EXISTS stack (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    aliases VARCHAR,  -- JSON-encoded
    labels VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS stack_name_uq ON stack(name);

CREATE TABLE IF NOT EXISTS command_outcome (
    id VARCHAR PRIMARY KEY,
    tool_call VARCHAR,  -- ref -> tool_call
    session VARCHAR,  -- ref -> session
    command_norm VARCHAR,
    command_tool VARCHAR,
    kind VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    text VARCHAR,
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS command_outcome_kind_ts ON command_outcome(kind, ts);
CREATE INDEX IF NOT EXISTS command_outcome_session ON command_outcome(session, ts);

CREATE TABLE IF NOT EXISTS user_message_ngram (
    id VARCHAR PRIMARY KEY,
    ngram VARCHAR NOT NULL,
    n BIGINT NOT NULL,
    count BIGINT NOT NULL DEFAULT 0,
    sessions VARCHAR,  -- JSON-encoded
    near_correction_count BIGINT NOT NULL DEFAULT 0,
    near_failed_tool_count BIGINT NOT NULL DEFAULT 0,
    near_edit_count BIGINT NOT NULL DEFAULT 0,
    near_verification_count BIGINT NOT NULL DEFAULT 0,
    first_seen TIMESTAMPTZ,
    last_seen TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS user_message_ngram_n_count ON user_message_ngram(n, count);
CREATE INDEX IF NOT EXISTS user_message_ngram_text ON user_message_ngram(ngram);

CREATE TABLE IF NOT EXISTS workflow_epoch (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    evidence_kind VARCHAR,
    evidence_ref VARCHAR,
    notes VARCHAR
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_epoch_name ON workflow_epoch(name);

CREATE TABLE IF NOT EXISTS session_token_usage (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    source VARCHAR NOT NULL,
    workflow_epoch VARCHAR,  -- ref -> workflow_epoch
    model VARCHAR,
    prompt_tokens BIGINT,
    completion_tokens BIGINT,
    cache_creation_input_tokens BIGINT,
    cache_read_input_tokens BIGINT,
    reasoning_output_tokens BIGINT,  -- codex total_token_usage.reasoning_output_tokens (claude has no split)
    estimated_tokens BIGINT NOT NULL,
    transcript_bytes BIGINT NOT NULL,
    context_window BIGINT,
    model_ref VARCHAR,  -- ref -> agent_model
    estimated_input_cost_usd DOUBLE,
    estimated_output_cost_usd DOUBLE,
    estimated_cache_creation_cost_usd DOUBLE,
    estimated_cache_read_cost_usd DOUBLE,
    estimated_cost_usd DOUBLE,
    pricing_source VARCHAR,
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    burn_buckets VARCHAR,  -- JSON-encoded number[]; sessions-list BURN sparkline
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS session_token_usage_session ON session_token_usage(session);
CREATE INDEX IF NOT EXISTS session_token_usage_epoch ON session_token_usage(workflow_epoch, source, ts);
CREATE INDEX IF NOT EXISTS session_token_usage_model ON session_token_usage(model_ref, ts);

CREATE TABLE IF NOT EXISTS turn_token_usage (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    turn VARCHAR NOT NULL,  -- ref -> turn
    seq BIGINT NOT NULL,
    source VARCHAR NOT NULL,
    model VARCHAR,
    prompt_tokens BIGINT,
    completion_tokens BIGINT,
    cache_creation_input_tokens BIGINT,
    cache_read_input_tokens BIGINT,
    reasoning_output_tokens BIGINT,  -- codex per-turn reasoning tokens (delta or last_token_usage)
    fresh_input_tokens BIGINT,
    estimated_tokens BIGINT NOT NULL,
    model_ref VARCHAR,  -- ref -> agent_model
    estimated_input_cost_usd DOUBLE,
    estimated_output_cost_usd DOUBLE,
    estimated_cache_creation_cost_usd DOUBLE,
    estimated_cache_read_cost_usd DOUBLE,
    estimated_cost_usd DOUBLE,
    pricing_source VARCHAR,
    usage_source VARCHAR NOT NULL,
    usage_quality VARCHAR NOT NULL,
    raw VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS turn_token_usage_turn ON turn_token_usage(turn);
CREATE INDEX IF NOT EXISTS turn_token_usage_session_seq ON turn_token_usage(session, seq);
CREATE INDEX IF NOT EXISTS turn_token_usage_model ON turn_token_usage(model_ref, ts);

CREATE TABLE IF NOT EXISTS session_health (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    source VARCHAR NOT NULL,
    workflow_epoch VARCHAR,  -- ref -> workflow_epoch
    turns BIGINT NOT NULL DEFAULT 0,
    tool_calls BIGINT NOT NULL DEFAULT 0,
    tool_errors BIGINT NOT NULL DEFAULT 0,
    user_corrections BIGINT NOT NULL DEFAULT 0,
    interruptions BIGINT NOT NULL DEFAULT 0,
    subagent_dispatches BIGINT NOT NULL DEFAULT 0,
    plan_snapshots BIGINT NOT NULL DEFAULT 0,
    estimated_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_ratio DOUBLE,
    cache_creation_ratio DOUBLE,
    context_pressure VARCHAR NOT NULL DEFAULT 'unknown',
    -- Precomputed attention metrics for the graph-explorer endpoint (issue #77).
    -- task_label: first organic-task user turn excerpt; turn counts by role/intent.
    -- Derived from turns once per ingest so the dashboard avoids per-row turn scans.
    task_label VARCHAR,
    user_turns BIGINT NOT NULL DEFAULT 0,
    assistant_turns BIGINT NOT NULL DEFAULT 0,
    correction_turns BIGINT NOT NULL DEFAULT 0,
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS session_health_session ON session_health(session);
CREATE INDEX IF NOT EXISTS session_health_epoch ON session_health(workflow_epoch, source, ts);

CREATE TABLE IF NOT EXISTS session_metrics (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    durability_ratio DOUBLE,
    produced_commits BIGINT NOT NULL DEFAULT 0,
    reverted_commits BIGINT NOT NULL DEFAULT 0,
    time_to_land_ms BIGINT,
    lines_added BIGINT NOT NULL DEFAULT 0,
    lines_removed BIGINT NOT NULL DEFAULT 0,
    time_to_first_edit_ms BIGINT,
    cold_start_reads BIGINT NOT NULL DEFAULT 0,
    delegation_ratio DOUBLE,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS session_metrics_session ON session_metrics(session);

-- Precomputed fragility_cascade signal edges (`ax signals show fragility_cascade`).
-- A session (origin) produced a reverted commit touching a file; a LATER, OTHER
-- session (downstream) edited the same file. Derived by derive-metrics with hard
-- limits (bounded reverted-commit anchor, mass reverts skipped, capped fragile
-- file set) and fully rewritten each run - the on-demand form risked the
-- documented 87k-edge `in.session` deref hang. The git<->tool-call file-key
-- namespace gap is bridged at derive time via checkout-root local-path twin
-- keys (issue #171; see apps/axctl/src/metrics/fragility-cascade.ts).
CREATE TABLE IF NOT EXISTS fragility_cascade (
    id VARCHAR PRIMARY KEY,
    origin VARCHAR NOT NULL,  -- ref -> session
    downstream VARCHAR NOT NULL,  -- ref -> session
    weight BIGINT NOT NULL DEFAULT 0,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS fragility_cascade_pair ON fragility_cascade(origin, downstream);

CREATE TABLE IF NOT EXISTS commit_classification (
    id VARCHAR PRIMARY KEY,
    commit VARCHAR NOT NULL,  -- ref -> commit
    repository VARCHAR,  -- ref -> repository
    kind VARCHAR NOT NULL,
    confidence VARCHAR NOT NULL,
    message VARCHAR,
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS commit_classification_commit ON commit_classification(commit);
CREATE INDEX IF NOT EXISTS commit_classification_kind_ts ON commit_classification(kind, ts);

CREATE TABLE IF NOT EXISTS branch (
    id VARCHAR PRIMARY KEY,
    repository VARCHAR NOT NULL,  -- ref -> repository
    name VARCHAR NOT NULL,
    head_sha VARCHAR,
    upstream VARCHAR,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS branch_repo_name ON branch(repository, name);

CREATE TABLE IF NOT EXISTS pull_request (
    id VARCHAR PRIMARY KEY,
    repository VARCHAR NOT NULL,  -- ref -> repository
    provider VARCHAR NOT NULL DEFAULT 'github',
    number BIGINT NOT NULL,
    title VARCHAR NOT NULL,
    state VARCHAR NOT NULL,
    base_branch VARCHAR,
    head_branch VARCHAR,
    head_sha VARCHAR,
    merge_sha VARCHAR,
    author VARCHAR,
    url VARCHAR,
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    merged_at TIMESTAMPTZ,
    additions BIGINT NOT NULL DEFAULT 0,
    deletions BIGINT NOT NULL DEFAULT 0,
    changed_files BIGINT NOT NULL DEFAULT 0,
    commit_count BIGINT NOT NULL DEFAULT 0,
    labels VARCHAR,
    raw VARCHAR,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_repo_number ON pull_request(repository, number);
CREATE INDEX IF NOT EXISTS pull_request_state ON pull_request(repository, state, updated_at);

CREATE TABLE IF NOT EXISTS review_event (
    id VARCHAR PRIMARY KEY,
    pull_request VARCHAR NOT NULL,  -- ref -> pull_request
    repository VARCHAR NOT NULL,  -- ref -> repository
    reviewer VARCHAR,
    reviewer_kind VARCHAR NOT NULL DEFAULT 'unknown',
    state VARCHAR NOT NULL,
    body_excerpt VARCHAR,
    severity VARCHAR NOT NULL DEFAULT 'unknown',
    category VARCHAR NOT NULL DEFAULT 'unknown',
    unresolved BOOLEAN NOT NULL DEFAULT FALSE,
    raw VARCHAR,
    ts TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS review_event_pr_ts ON review_event(pull_request, ts);
CREATE INDEX IF NOT EXISTS review_event_severity ON review_event(repository, severity, ts);

CREATE TABLE IF NOT EXISTS check_run (
    id VARCHAR PRIMARY KEY,
    pull_request VARCHAR,  -- ref -> pull_request
    commit VARCHAR,  -- ref -> commit
    repository VARCHAR NOT NULL,  -- ref -> repository
    provider VARCHAR NOT NULL DEFAULT 'github',
    name VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    conclusion VARCHAR,
    url VARCHAR,
    raw VARCHAR,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS check_run_pr ON check_run(pull_request, status, conclusion);
CREATE INDEX IF NOT EXISTS check_run_commit ON check_run(commit, status, conclusion);

CREATE TABLE IF NOT EXISTS delivery_outcome (
    id VARCHAR PRIMARY KEY,
    session VARCHAR,  -- ref -> session
    repository VARCHAR,  -- ref -> repository
    checkout VARCHAR,  -- ref -> checkout
    pull_request VARCHAR,  -- ref -> pull_request
    status VARCHAR NOT NULL,
    promotion_path VARCHAR NOT NULL DEFAULT 'unknown',
    main_branch VARCHAR,
    produced_commits VARCHAR,
    promoted_commits VARCHAR,
    pr_size VARCHAR,
    review_pain VARCHAR,
    phase_metrics VARCHAR,
    confidence VARCHAR NOT NULL DEFAULT 'medium',
    evidence VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_session ON delivery_outcome(session);
CREATE INDEX IF NOT EXISTS delivery_pr ON delivery_outcome(pull_request);
CREATE INDEX IF NOT EXISTS delivery_status ON delivery_outcome(repository, status, updated_at);

CREATE TABLE IF NOT EXISTS workflow_snapshot (
    id VARCHAR PRIMARY KEY,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload VARCHAR NOT NULL,
    source VARCHAR NOT NULL DEFAULT 'workflow-refresh'
);
CREATE INDEX IF NOT EXISTS workflow_snapshot_generated ON workflow_snapshot(generated_at);

CREATE TABLE IF NOT EXISTS phase_span (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    phase VARCHAR NOT NULL,
    start_turn VARCHAR,  -- ref -> turn
    end_turn VARCHAR,  -- ref -> turn
    start_ts TIMESTAMPTZ NOT NULL,
    end_ts TIMESTAMPTZ NOT NULL,
    duration_ms BIGINT NOT NULL,
    user_turns BIGINT NOT NULL DEFAULT 0,
    assistant_turns BIGINT NOT NULL DEFAULT 0,
    tool_calls BIGINT NOT NULL DEFAULT 0,
    files_read BIGINT NOT NULL DEFAULT 0,
    files_touched BIGINT NOT NULL DEFAULT 0,
    tests_run BIGINT NOT NULL DEFAULT 0,
    interruptions BIGINT NOT NULL DEFAULT 0,
    corrections BIGINT NOT NULL DEFAULT 0,
    metrics VARCHAR,
    evidence VARCHAR
);
CREATE INDEX IF NOT EXISTS phase_span_session_phase ON phase_span(session, phase);

CREATE TABLE IF NOT EXISTS skill_candidate (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    trigger_pattern VARCHAR NOT NULL,
    suspected_gap VARCHAR NOT NULL,
    proposed_behavior VARCHAR NOT NULL,
    confidence VARCHAR NOT NULL,
    expected_impact VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'candidate',
    labels VARCHAR,  -- JSON-encoded
    metrics VARCHAR,  -- JSON-encoded
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_candidate_name ON skill_candidate(name);
CREATE INDEX IF NOT EXISTS skill_candidate_status ON skill_candidate(status, created_at);
CREATE TABLE IF NOT EXISTS ingest_run (
    id VARCHAR PRIMARY KEY,
    command VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'running',
    since_days BIGINT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Heartbeat: bumped on every stage start/finish so a genuinely-live "running"
    -- run is distinguishable from one stranded by a crash (doctor stale-run check).
    last_progress_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    metrics VARCHAR  -- JSON
);
CREATE INDEX IF NOT EXISTS ingest_run_status_started ON ingest_run(status, started_at);

CREATE TABLE IF NOT EXISTS ingest_stage (
    id VARCHAR PRIMARY KEY,
    run VARCHAR NOT NULL,  -- ref -> ingest_run
    source VARCHAR NOT NULL,
    stage VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMPTZ,
    counts VARCHAR,  -- JSON
    error_text VARCHAR
);
CREATE INDEX IF NOT EXISTS ingest_stage_run ON ingest_stage(run, started_at);

CREATE TABLE IF NOT EXISTS ingest_event (
    id VARCHAR PRIMARY KEY,
    run VARCHAR NOT NULL,  -- ref -> ingest_run
    source VARCHAR NOT NULL,
    stage VARCHAR NOT NULL,
    level VARCHAR NOT NULL,
    message VARCHAR NOT NULL,
    counts VARCHAR,  -- JSON
    raw VARCHAR,  -- JSON
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ingest_event_run_ts ON ingest_event(run, ts);
CREATE INDEX IF NOT EXISTS ingest_event_source_ts ON ingest_event(source, ts);

CREATE TABLE IF NOT EXISTS query_sample (
    id VARCHAR PRIMARY KEY,
    name VARCHAR,
    sql VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    duration_ms BIGINT,
    error_text VARCHAR,
    row_count BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS graph_health_check (
    id VARCHAR PRIMARY KEY,
    kind VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    count BIGINT NOT NULL DEFAULT 0,
    rows VARCHAR,  -- JSON
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS graph_health_kind_created ON graph_health_check(kind, created_at);

-- ==== Skill roles (P3.1) ====
-- Multi-role natural: one skill -> many plays_role edges. Weighted query
-- joins invoked -> skill -> plays_role -> role.
CREATE TABLE IF NOT EXISTS role (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    -- Surreal carried `VALUE $value ?? 1.0` here to stop a CONTENT-style upsert
    -- from coercing weight to NONE. DuckDB has no NONE, and NOT NULL DEFAULT 1.0
    -- gives the same guarantee; the Surreal repair UPDATE was one-time DML with
    -- no legacy rows to repair in a fresh cache.
    weight DOUBLE NOT NULL DEFAULT 1.0
);
CREATE UNIQUE INDEX IF NOT EXISTS role_name_uq ON role(name);

CREATE TABLE IF NOT EXISTS plays_role (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> skill
    out_id VARCHAR NOT NULL,  -- ref -> role
    confidence DOUBLE NOT NULL DEFAULT 1.0,
    source VARCHAR NOT NULL,
    weight DOUBLE,
    rationale VARCHAR,
    since TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS plays_role_in ON plays_role(in_id);
CREATE INDEX IF NOT EXISTS plays_role_out ON plays_role(out_id);

-- ==== Relations (taste graph) ====

-- invoked: explicit Skill tool call.
CREATE TABLE IF NOT EXISTS invoked (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> skill
    args VARCHAR,  -- JSON
    ts TIMESTAMPTZ NOT NULL,
    -- Denormalised source session. Session-detail top-skills must avoid
    -- dereferencing the source turn's session across every invoked edge for
    -- large sessions.
    session VARCHAR,  -- ref -> session
    -- Denormalised copies of the source turn's `has_error` and "was corrected
    -- within 3 user turns" flags, so the taste aggregates collapse to a single
    -- GROUP BY instead of a per-edge row fetch (issue #31).
    turn_has_error BOOLEAN NOT NULL DEFAULT FALSE,
    was_corrected BOOLEAN NOT NULL DEFAULT FALSE,
    -- Position fields for P3.1: turn_index = seq at write time; total_turns and
    -- is_first are backfilled by the invoked-positions stage after all
    -- transcripts are ingested, so they stay nullable.
    turn_index BIGINT,
    total_turns BIGINT,
    is_first BOOLEAN
);
CREATE INDEX IF NOT EXISTS invoked_out_ts ON invoked(out_id, ts);
CREATE INDEX IF NOT EXISTS invoked_session_out_ts ON invoked(session, out_id, ts);
CREATE INDEX IF NOT EXISTS invoked_in_out_args ON invoked(in_id, out_id, args);
CREATE INDEX IF NOT EXISTS invoked_in ON invoked(in_id);
CREATE INDEX IF NOT EXISTS invoked_out ON invoked(out_id);

-- Auto-load activations: a skill pulled in by a subagent's `skills:` frontmatter
-- when that agent spawns. NO Skill-tool call fires, so these never appear as
-- `invoked` edges. Kept SEPARATE from `invoked` so usage analytics (skills
-- weighted/taste/churn) are not polluted with non-invocations. Derived by the
-- `loaded-skills` stage from spawned x agent_def x skill (fully rebuildable).
CREATE TABLE IF NOT EXISTS loaded (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> session
    out_id VARCHAR NOT NULL,  -- ref -> skill
    ts TIMESTAMPTZ NOT NULL,
    agent VARCHAR,  -- the scoping agent
    source VARCHAR NOT NULL DEFAULT 'frontmatter'
);
CREATE INDEX IF NOT EXISTS loaded_out ON loaded(out_id);
CREATE INDEX IF NOT EXISTS loaded_in ON loaded(in_id);

-- proposed: assistant text mentioned skill, never invoked.
CREATE TABLE IF NOT EXISTS proposed (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> skill
    ts TIMESTAMPTZ NOT NULL,
    context_excerpt VARCHAR
);
-- proposed-but-never-invoked counts traverse the skill side.
CREATE INDEX IF NOT EXISTS proposed_out ON proposed(out_id);
CREATE INDEX IF NOT EXISTS proposed_in ON proposed(in_id);

-- edited: Edit/Write tool fired.
CREATE TABLE IF NOT EXISTS edited (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> file
    tool VARCHAR NOT NULL,  -- 'Edit'|'Write'|'NotebookEdit'
    ts TIMESTAMPTZ NOT NULL,
    checkout VARCHAR,  -- ref -> checkout
    path_seen VARCHAR,
    absolute_path_seen VARCHAR,
    edit_kind VARCHAR
);
-- `edited` lookups by source turn (e.g., 'which files did this session edit').
CREATE INDEX IF NOT EXISTS edited_in ON edited(in_id);
CREATE INDEX IF NOT EXISTS edited_in_out_tool ON edited(in_id, out_id, tool);
-- edited_out backs the fragility-cascade derive's chunked `edited WHERE out_id IN
-- [files]` lookups so each chunk seeks the index instead of scanning the edited
-- table; results are precomputed into fragility_cascade (issue #171).
CREATE INDEX IF NOT EXISTS edited_out ON edited(out_id);

CREATE TABLE IF NOT EXISTS mentioned_file (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> file
    source VARCHAR NOT NULL DEFAULT 'text',  -- 'text' | 'tool_input' | 'tool_output'
    confidence DOUBLE,
    excerpt VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mentioned_file_in ON mentioned_file(in_id);
CREATE INDEX IF NOT EXISTS mentioned_file_out ON mentioned_file(out_id);
CREATE INDEX IF NOT EXISTS mentioned_file_in_out_source ON mentioned_file(in_id, out_id, source);

CREATE TABLE IF NOT EXISTS mentioned_symbol (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> symbol
    source VARCHAR NOT NULL DEFAULT 'text',
    confidence DOUBLE,
    excerpt VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mentioned_symbol_in ON mentioned_symbol(in_id);
CREATE INDEX IF NOT EXISTS mentioned_symbol_out ON mentioned_symbol(out_id);

CREATE TABLE IF NOT EXISTS mentioned_error (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> error_signature
    source VARCHAR NOT NULL DEFAULT 'text',
    confidence DOUBLE,
    excerpt VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS mentioned_error_in ON mentioned_error(in_id);
CREATE INDEX IF NOT EXISTS mentioned_error_out ON mentioned_error(out_id);

CREATE TABLE IF NOT EXISTS read_file (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> tool_call
    out_id VARCHAR NOT NULL,  -- ref -> file
    evidence VARCHAR,  -- 'tool_name' | 'command_norm'
    path_seen VARCHAR,
    absolute_path_seen VARCHAR,
    excerpt VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS read_file_in ON read_file(in_id);
CREATE INDEX IF NOT EXISTS read_file_out ON read_file(out_id);

CREATE TABLE IF NOT EXISTS searched_file (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> tool_call
    out_id VARCHAR NOT NULL,  -- ref -> file
    evidence VARCHAR,  -- 'tool_name' | 'command_norm' | 'output_match'
    path_seen VARCHAR,
    absolute_path_seen VARCHAR,
    excerpt VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS searched_file_in ON searched_file(in_id);
CREATE INDEX IF NOT EXISTS searched_file_out ON searched_file(out_id);

-- corrected_by: assistant turn -> next user turn that pushed back.
CREATE TABLE IF NOT EXISTS corrected_by (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> turn
    pattern VARCHAR,  -- which negation pattern matched
    ts TIMESTAMPTZ NOT NULL
);
-- correction-rate lookups walk the assistant turn that was corrected.
CREATE INDEX IF NOT EXISTS corrected_by_in ON corrected_by(in_id);
CREATE INDEX IF NOT EXISTS corrected_by_out ON corrected_by(out_id);

CREATE TABLE IF NOT EXISTS expresses (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> semantic_signal
    analysis VARCHAR NOT NULL,  -- ref -> turn_analysis
    session VARCHAR,  -- ref -> session
    confidence DOUBLE NOT NULL,
    method VARCHAR NOT NULL,
    ts TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS expresses_in ON expresses(in_id);
CREATE INDEX IF NOT EXISTS expresses_out ON expresses(out_id);
CREATE INDEX IF NOT EXISTS expresses_session_ts ON expresses(session, ts);

CREATE TABLE IF NOT EXISTS reacts_to (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> turn
    session VARCHAR,  -- ref -> session
    polarity VARCHAR NOT NULL,
    act VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL,
    signal VARCHAR,  -- ref -> semantic_signal
    ts TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS reacts_to_in ON reacts_to(in_id);
CREATE INDEX IF NOT EXISTS reacts_to_out ON reacts_to(out_id);
CREATE INDEX IF NOT EXISTS reacts_to_session_ts ON reacts_to(session, ts);

CREATE TABLE IF NOT EXISTS has_classification (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> classifier_result
    classifier_key VARCHAR NOT NULL,
    label VARCHAR NOT NULL,
    target VARCHAR NOT NULL,
    confidence DOUBLE NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS has_classification_in ON has_classification(in_id);
CREATE INDEX IF NOT EXISTS has_classification_out ON has_classification(out_id);
CREATE INDEX IF NOT EXISTS has_classification_theme ON has_classification(classifier_key, label, target);
CREATE TABLE IF NOT EXISTS produced (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> session
    out_id VARCHAR NOT NULL,  -- ref -> commit
    repository VARCHAR,  -- ref -> repository
    checkout VARCHAR,  -- ref -> checkout
    ts TIMESTAMPTZ,
    source VARCHAR,
    kind VARCHAR
);
CREATE INDEX IF NOT EXISTS produced_in_ts ON produced(in_id, ts);
CREATE INDEX IF NOT EXISTS produced_out_ts ON produced(out_id, ts);
CREATE INDEX IF NOT EXISTS produced_repository_checkout_ts ON produced(repository, checkout, ts);
CREATE INDEX IF NOT EXISTS produced_in ON produced(in_id);
CREATE INDEX IF NOT EXISTS produced_out ON produced(out_id);

CREATE TABLE IF NOT EXISTS touched (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> commit
    out_id VARCHAR NOT NULL,  -- ref -> file
    additions BIGINT,
    deletions BIGINT,
    status VARCHAR,
    old_path VARCHAR,
    new_path VARCHAR,
    repository VARCHAR,  -- ref -> repository
    checkout VARCHAR,  -- ref -> checkout
    ts TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS touched_in ON touched(in_id);
CREATE INDEX IF NOT EXISTS touched_out ON touched(out_id);
CREATE INDEX IF NOT EXISTS touched_repository_ts ON touched(repository, ts);
CREATE INDEX IF NOT EXISTS touched_checkout_ts ON touched(checkout, ts);
CREATE INDEX IF NOT EXISTS touched_in_checkout ON touched(in_id, checkout);

CREATE TABLE IF NOT EXISTS later_fixed_by (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> commit
    out_id VARCHAR NOT NULL,  -- ref -> commit
    repository VARCHAR,  -- ref -> repository
    overlap_files VARCHAR,  -- JSON
    overlap_count BIGINT NOT NULL DEFAULT 0,
    days_between DOUBLE,
    confidence VARCHAR NOT NULL,
    reason VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS later_fixed_by_in ON later_fixed_by(in_id);
CREATE INDEX IF NOT EXISTS later_fixed_by_out ON later_fixed_by(out_id);

CREATE TABLE IF NOT EXISTS suggests_skill (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> commit
    out_id VARCHAR NOT NULL,  -- ref -> skill_candidate
    reason VARCHAR,
    evidence VARCHAR,  -- JSON
    confidence VARCHAR NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS suggests_skill_in ON suggests_skill(in_id);
CREATE INDEX IF NOT EXISTS suggests_skill_out ON suggests_skill(out_id);

CREATE TABLE IF NOT EXISTS has_checkout (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> repository
    out_id VARCHAR NOT NULL,  -- ref -> checkout
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS has_checkout_in ON has_checkout(in_id);
CREATE INDEX IF NOT EXISTS has_checkout_out ON has_checkout(out_id);

-- Untyped relation in Surreal (no FROM/TO): endpoints are whatever the writer
-- relates, so in_id / out_id carry ids from more than one table. `in_table` /
-- `out_table` recover the table name Surreal's own record id would have carried
-- inline (P1-1 - see the POLYMORPHIC EDGES note in the file header); both sides
-- are polymorphic on every table in this block, so both columns are required.
CREATE TABLE IF NOT EXISTS concerns (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    in_table VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    kind VARCHAR,
    weight BIGINT,
    reason VARCHAR,
    labels VARCHAR,  -- JSON
    metrics VARCHAR,  -- JSON
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS concerns_in ON concerns(in_id);
CREATE INDEX IF NOT EXISTS concerns_out ON concerns(out_id);
CREATE INDEX IF NOT EXISTS concerns_in_out_kind ON concerns(in_id, out_id, kind);

CREATE TABLE IF NOT EXISTS resulted_in (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    in_table VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    kind VARCHAR,
    labels VARCHAR,  -- JSON
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS resulted_in_in ON resulted_in(in_id);
CREATE INDEX IF NOT EXISTS resulted_in_out ON resulted_in(out_id);

CREATE TABLE IF NOT EXISTS produced_artifact (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    in_table VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    kind VARCHAR,
    labels VARCHAR,  -- JSON
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS produced_artifact_in ON produced_artifact(in_id);
CREATE INDEX IF NOT EXISTS produced_artifact_out ON produced_artifact(out_id);

CREATE TABLE IF NOT EXISTS has_artifact (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    in_table VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    kind VARCHAR,
    labels VARCHAR,  -- JSON
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS has_artifact_in ON has_artifact(in_id);
CREATE INDEX IF NOT EXISTS has_artifact_out ON has_artifact(out_id);

CREATE TABLE IF NOT EXISTS derived_from (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    in_table VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    kind VARCHAR,
    labels VARCHAR,  -- JSON
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS derived_from_in ON derived_from(in_id);
CREATE INDEX IF NOT EXISTS derived_from_out ON derived_from(out_id);

-- skill_paired: skills co-occurring in the same session within N turns.
CREATE TABLE IF NOT EXISTS skill_paired (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> skill
    out_id VARCHAR NOT NULL,  -- ref -> skill
    count BIGINT NOT NULL DEFAULT 1,
    last_seen TIMESTAMPTZ NOT NULL
);
-- Endpoint indexes: the dashboard skill-detail `paired` block filters by
-- `in_id = $skill OR out_id = $skill` (apps/axctl/src/queries/skill-detail.ts).
CREATE INDEX IF NOT EXISTS skill_paired_in ON skill_paired(in_id);
CREATE INDEX IF NOT EXISTS skill_paired_out ON skill_paired(out_id);

-- recovered_by: skill invoked after a has_error=true turn.
CREATE TABLE IF NOT EXISTS recovered_by (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> turn
    out_id VARCHAR NOT NULL,  -- ref -> skill
    ts TIMESTAMPTZ NOT NULL,
    error_excerpt VARCHAR
);
CREATE INDEX IF NOT EXISTS recovered_by_in ON recovered_by(in_id);
CREATE INDEX IF NOT EXISTS recovered_by_out ON recovered_by(out_id);

-- ---------------------------------------------------------------------------
-- Parent session -> spawned child session. Lets us reconstruct work episodes
-- (one user-driven workflow that fans out across many subagent sessions) from
-- the flat session table. Derived from `tool_call` rows where
-- name='spawn_agent' or name='Task': output payload carries the child's
-- session id (codex uses `agent_id`, Claude Task uses the subagent transcript
-- id), and the row's session is related to that target.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spawned (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> session
    out_id VARCHAR NOT NULL,  -- ref -> session
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    tool VARCHAR,  -- e.g. "spawn_agent" | "Task"
    tool_call VARCHAR,  -- ref -> tool_call
    nickname VARCHAR,  -- codex assigns "Turing", "Babbage", etc.
    agent_type VARCHAR,  -- from agent-<id>.meta.json agentType
    description VARCHAR,  -- from agent-<id>.meta.json description
    agent_name VARCHAR,  -- from agent-<id>.meta.json name
    tool_use_id VARCHAR  -- from agent-<id>.meta.json toolUseId; joins parent tool_call.call_id
);
CREATE INDEX IF NOT EXISTS spawned_in ON spawned(in_id);
CREATE INDEX IF NOT EXISTS spawned_out ON spawned(out_id);

-- Hook advice ledger: one row per PreToolUse[Agent] hook fire, written by
-- ~/.ax/hooks/advise-tap.ts. CC injects route advice as additionalContext but
-- never logs it (and the OTLP hook span has no payload), so this is the only
-- place the advice text survives. `session` links the PARENT/advised session;
-- the advice is joined to its dispatch (the `spawned` edge FROM that session) by
-- description at query time.
CREATE TABLE IF NOT EXISTS advice (
    id VARCHAR PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    session VARCHAR,  -- ref -> session (parent/advised session)
    tool VARCHAR,  -- normally "Agent"
    description VARCHAR,  -- dispatch tool_input.description (join key)
    verdict VARCHAR NOT NULL DEFAULT 'allow',  -- "advise" | "allow"
    advice_text VARCHAR,  -- the injected additionalContext
    suggested_model VARCHAR  -- tier parsed from advice_text
);
CREATE INDEX IF NOT EXISTS advice_ts ON advice(ts);

CREATE TABLE IF NOT EXISTS agent_event_child (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> agent_event
    out_id VARCHAR NOT NULL,  -- ref -> agent_event
    agent_session VARCHAR NOT NULL,  -- ref -> agent_session
    provider VARCHAR NOT NULL,  -- ref -> agent_provider
    kind VARCHAR NOT NULL DEFAULT 'parent',
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS agent_event_child_in ON agent_event_child(in_id);
CREATE INDEX IF NOT EXISTS agent_event_child_out ON agent_event_child(out_id);

CREATE TABLE IF NOT EXISTS used_model (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> session
    out_id VARCHAR NOT NULL,  -- ref -> agent_model
    session_token_usage VARCHAR,  -- ref -> session_token_usage
    source VARCHAR NOT NULL,
    estimated_tokens BIGINT NOT NULL DEFAULT 0,
    estimated_cost_usd DOUBLE,
    pricing_source VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS used_model_in ON used_model(in_id);
CREATE INDEX IF NOT EXISTS used_model_out ON used_model(out_id);

CREATE TABLE IF NOT EXISTS agent_used_model (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,  -- ref -> agent_session
    out_id VARCHAR NOT NULL,  -- ref -> agent_model
    provider VARCHAR NOT NULL,  -- ref -> agent_provider
    source VARCHAR NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS agent_used_model_in ON agent_used_model(in_id);
CREATE INDEX IF NOT EXISTS agent_used_model_out ON agent_used_model(out_id);

-- ---------------------------------------------------------------------------
-- User-facing triage decisions on skills. The dashboard "Skill Triage" view
-- writes here; downstream queries can filter `archived` skills out of the
-- leaderboard. We never delete: keep history of decision flips with `decided_at`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_triage_decision (
    id VARCHAR PRIMARY KEY,
    skill_name VARCHAR NOT NULL,
    decision VARCHAR NOT NULL,  -- keep | archive | review
    reason VARCHAR,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_triage_decision_name ON skill_triage_decision(skill_name);

-- ---------------------------------------------------------------------------
-- Native agent-harness hook evidence. These rows describe the harness layer
-- itself (Claude/Codex lifecycle hooks), not ax's experimental recall hook.
-- One Harness Hook Event may invoke multiple Hook Commands.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS harness_hook_event (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    ts TIMESTAMPTZ NOT NULL,
    harness VARCHAR NOT NULL,  -- claude | codex
    event_name VARCHAR NOT NULL,  -- PreToolUse | PostToolUse | SessionStart | ...
    hook_name VARCHAR NOT NULL,  -- e.g. PreToolUse:Bash
    tool_call_id VARCHAR,
    tool_call VARCHAR,  -- ref -> tool_call
    cwd VARCHAR,
    transcript_uuid VARCHAR,
    -- hook_progress | hook_success | hook_blocking_error | hook_additional_context
    -- | tool_result_text (blocks recovered from tool-result text, #743)
    source_type VARCHAR NOT NULL
);
CREATE INDEX IF NOT EXISTS harness_hook_event_by_ts ON harness_hook_event(ts);
CREATE INDEX IF NOT EXISTS harness_hook_event_by_session ON harness_hook_event(session);
CREATE INDEX IF NOT EXISTS harness_hook_event_by_name ON harness_hook_event(hook_name);
CREATE INDEX IF NOT EXISTS harness_hook_event_by_tool ON harness_hook_event(tool_call);

CREATE TABLE IF NOT EXISTS hook_command_invocation (
    id VARCHAR PRIMARY KEY,
    hook_event VARCHAR NOT NULL,  -- ref -> harness_hook_event
    session VARCHAR NOT NULL,  -- ref -> session
    ts TIMESTAMPTZ NOT NULL,
    harness VARCHAR NOT NULL,  -- claude | codex
    event_name VARCHAR NOT NULL,
    hook_name VARCHAR NOT NULL,
    tool_call_id VARCHAR,
    tool_call VARCHAR,  -- ref -> tool_call
    command VARCHAR NOT NULL,
    command_hash VARCHAR NOT NULL,
    provider_status VARCHAR NOT NULL,  -- progress_only | success | blocking_error
    -- allowed | blocked | injected_context | modified_input | notified | no_op | unknown
    effect VARCHAR NOT NULL,
    exit_code BIGINT,
    duration_ms BIGINT,
    stdout_excerpt VARCHAR,
    stderr_excerpt VARCHAR,
    content_excerpt VARCHAR,
    blocking_error_excerpt VARCHAR
);
CREATE INDEX IF NOT EXISTS hook_command_invocation_by_ts ON hook_command_invocation(ts);
CREATE INDEX IF NOT EXISTS hook_command_invocation_by_session ON hook_command_invocation(session);
CREATE INDEX IF NOT EXISTS hook_command_invocation_by_event ON hook_command_invocation(hook_event);
CREATE INDEX IF NOT EXISTS hook_command_invocation_by_command ON hook_command_invocation(command_hash);
CREATE INDEX IF NOT EXISTS hook_command_invocation_by_status ON hook_command_invocation(provider_status);
CREATE INDEX IF NOT EXISTS hook_command_invocation_by_effect ON hook_command_invocation(effect);

-- ---------------------------------------------------------------------------
-- ax's own CLI invocations (redacted) for self-telemetry / utilization.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ax_invocation (
    id VARCHAR PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    command VARCHAR NOT NULL,
    flags VARCHAR NOT NULL,
    exit_code BIGINT NOT NULL,
    duration_ms BIGINT NOT NULL,
    origin VARCHAR NOT NULL,
    repo_key VARCHAR,
    ax_version VARCHAR NOT NULL
);
CREATE INDEX IF NOT EXISTS ax_invocation_by_ts ON ax_invocation(ts);
CREATE INDEX IF NOT EXISTS ax_invocation_by_command ON ax_invocation(command, ts);

-- ---------------------------------------------------------------------------
-- Generic feedback case definitions and deterministic backtest results.
-- Case types encode "what behavior should follow this evidence?" without
-- creating hook-specific tables. Results are per evidence item/run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback_case_type (
    id VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    target_kind VARCHAR NOT NULL,  -- hook_command_invocation | tool_call | session | ...
    selector_json VARCHAR NOT NULL,  -- JSON
    rule_kind VARCHAR NOT NULL,  -- deterministic | ai_review | hybrid
    rule_json VARCHAR NOT NULL,  -- JSON
    status VARCHAR NOT NULL DEFAULT 'active',  -- active | paused | retired
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_case_type_name ON feedback_case_type(name);
CREATE INDEX IF NOT EXISTS feedback_case_type_status ON feedback_case_type(status);

CREATE TABLE IF NOT EXISTS feedback_case_result (
    id VARCHAR PRIMARY KEY,
    case_type VARCHAR NOT NULL,  -- ref -> feedback_case_type
    target_kind VARCHAR NOT NULL,
    target VARCHAR,  -- ref -> hook_command_invocation
    session VARCHAR,  -- ref -> session
    ts TIMESTAMPTZ NOT NULL,
    status VARCHAR NOT NULL,  -- passed | failed | inconclusive
    reason VARCHAR NOT NULL,
    window_json VARCHAR NOT NULL,  -- JSON (inspected window)
    evidence_json VARCHAR NOT NULL,  -- JSON (matched evidence)
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS feedback_case_result_by_case ON feedback_case_result(case_type, observed_at);
CREATE INDEX IF NOT EXISTS feedback_case_result_by_status ON feedback_case_result(status);
CREATE INDEX IF NOT EXISTS feedback_case_result_by_session ON feedback_case_result(session);

-- ---------------------------------------------------------------------------
-- Hook-fire telemetry. Every `axctl hook file-context` decision (inject or
-- skip) writes a row here. Codex transcripts replay-synthesize rows too.
-- See docs/superpowers/specs/2026-05-17-hook-fire-telemetry-design.md.
--
-- The row id is the content hash of (harness, session id, file path, ts, event)
-- so Codex replay upserts idempotently on re-ingest (see @ax/lib/stable-id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hook_fire (
    id VARCHAR PRIMARY KEY,
    -- Common telemetry base fields (mirrors packages/lib/src/telemetry-base.ts).
    ts TIMESTAMPTZ NOT NULL,
    kind VARCHAR NOT NULL,  -- always "hook_fire"
    session VARCHAR,  -- ref -> session
    file VARCHAR,  -- ref -> file
    file_path VARCHAR NOT NULL,  -- raw path even when no file record exists
    harness VARCHAR NOT NULL,  -- claude | codex | unknown
    ok BOOLEAN NOT NULL,
    latency_ms BIGINT NOT NULL,
    -- Hook-fire-specific fields.
    event VARCHAR NOT NULL,  -- pre-edit | read | write | search | unknown
    inject BOOLEAN NOT NULL,
    -- high_signal | suppressed_path | no_prior_sessions | low_signal_only | no_files
    reason VARCHAR NOT NULL,
    prior_sessions_considered BIGINT NOT NULL,
    task_excerpt VARCHAR NOT NULL,  -- clipped 240 chars
    top_prior_sessions VARCHAR NOT NULL,  -- JSON session-record-id array; a record[] element type, so out of P2-3 scalar-array scope
    injected_titles VARCHAR[] NOT NULL DEFAULT []  -- clipped titles of injected sessions (max 3, empty when inject=false); P2-3: native list
);
CREATE INDEX IF NOT EXISTS hook_fire_by_ts ON hook_fire(ts);
CREATE INDEX IF NOT EXISTS hook_fire_by_session ON hook_fire(session);
CREATE INDEX IF NOT EXISTS hook_fire_by_file ON hook_fire(file);
CREATE INDEX IF NOT EXISTS hook_fire_by_reason ON hook_fire(reason);
CREATE TABLE IF NOT EXISTS proposal (
    id VARCHAR PRIMARY KEY,
    form VARCHAR NOT NULL,
    -- skill | subagent | hook | guidance | automation
    title VARCHAR NOT NULL,
    hypothesis VARCHAR NOT NULL,
    dedupe_sig VARCHAR NOT NULL,
    frequency BIGINT NOT NULL DEFAULT 0,
    confidence VARCHAR NOT NULL,
    -- low | medium | high
    status VARCHAR NOT NULL DEFAULT 'open',
    -- open | accepted | rejected | superseded
    -- mined (signal-derived) | agent (written via `ax improve propose`).
    -- The VALUE clause coerces a NONE/absent write back to 'mined' so a bare
    -- `UPDATE proposal SET ...` (accept/reject/housekeep/re-derive) that omits
    -- `origin` can never re-coerce an old NONE row and crash with "Expected string
    -- but found `NONE`" (issue #472). It tests `IS NONE` explicitly rather than the
    -- broader `?? ` so an *explicit* NULL write still fails type coercion (a real
    -- bug surfaces) instead of being silently relabeled 'mined'. DEFAULT still seeds
    -- 'mined' on first create; an explicit origin='agent' write is preserved.
    -- was: DEFINE FIELD OVERWRITE origin ... VALUE IF $value IS NONE THEN 'mined' ELSE $value END
    -- (the NONE-coercion VALUE clause has no DuckDB equivalent and is dropped;
    -- the DEFAULT alone covers the create-time seed)
    origin VARCHAR NOT NULL DEFAULT 'mined',
    hypothesis_template VARCHAR,
    -- hypothesis with {{placeholders}} hydrated at serve time from
    -- evidence_query's first row - numbers never expire
    evidence_query VARCHAR,
    -- read-only SurrealQL (SELECT/RETURN only, validated at write AND
    -- serve) producing the row that fills hypothesis_template
    reject_reason VARCHAR,
    baseline VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS proposal_dedupe_uq ON proposal(dedupe_sig);
CREATE INDEX IF NOT EXISTS proposal_status_freq ON proposal(status, frequency);
CREATE INDEX IF NOT EXISTS proposal_form_status ON proposal(form, status, created_at);

-- ==== Directive n-gram lift table (#587) ====
-- Per-user lift table: which n-gram markers in user turns predict a captured
-- outcome (correction follow-up, friction_event, classifier signal). Keyed by
-- `ngram` (the whole local DB is per-user, so there is NO user column).
-- Filled by later tasks in Milestone A; this task only defines the schema.
CREATE TABLE IF NOT EXISTS directive_ngram (
    id VARCHAR PRIMARY KEY,
    ngram VARCHAR NOT NULL,
    n BIGINT NOT NULL,            -- token count (1..4)
    occurrences BIGINT NOT NULL DEFAULT 0, -- turns containing the ngram
    outcomes BIGINT NOT NULL DEFAULT 0, -- of those, # followed by a captured outcome
    lift DOUBLE NOT NULL DEFAULT 0, -- P(outcome|ngram)/P(outcome)
    sessions BIGINT NOT NULL DEFAULT 0, -- distinct sessions (sparsity guard)
    first_seen TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMPTZ,
    refit_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS directive_ngram_uq ON directive_ngram(ngram);
CREATE INDEX IF NOT EXISTS directive_ngram_lift ON directive_ngram(lift);

-- ==== Per-form payload tables ====
-- One row per proposal of the matching form. Typed fields per form avoid
-- the JSON-blob trap that killed the prior orphan tables.

CREATE TABLE IF NOT EXISTS skill_proposal (
    id VARCHAR PRIMARY KEY,
    proposal VARCHAR NOT NULL,  -- ref -> proposal (was: REFERENCE ON DELETE CASCADE)
    trigger_pattern VARCHAR NOT NULL,
    suspected_gap VARCHAR NOT NULL,
    proposed_behavior VARCHAR NOT NULL,
    expected_impact VARCHAR
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_proposal_uq ON skill_proposal(proposal);

CREATE TABLE IF NOT EXISTS subagent_proposal (
    id VARCHAR PRIMARY KEY,
    proposal VARCHAR NOT NULL,  -- ref -> proposal (was: REFERENCE ON DELETE CASCADE)
    bounded_role VARCHAR NOT NULL,
    delegation_trigger VARCHAR NOT NULL,
    -- pattern matched against Task tool calls (see opportunity definition below)
    example_task_patterns VARCHAR[] NOT NULL DEFAULT []  -- P2-3: native list, not JSON
);
CREATE UNIQUE INDEX IF NOT EXISTS subagent_proposal_uq ON subagent_proposal(proposal);

CREATE TABLE IF NOT EXISTS hook_proposal (
    id VARCHAR PRIMARY KEY,
    proposal VARCHAR NOT NULL,  -- ref -> proposal (was: REFERENCE ON DELETE CASCADE)
    event_name VARCHAR NOT NULL,
    -- PreToolUse | PostToolUse | SessionStart | ...
    target_tool VARCHAR,
    hook_command VARCHAR NOT NULL,
    recovery_path VARCHAR,
    smoke_test_command VARCHAR,
    disable_command VARCHAR,
    failure_mode VARCHAR
    -- fail_open | fail_closed
);
CREATE UNIQUE INDEX IF NOT EXISTS hook_proposal_uq ON hook_proposal(proposal);

CREATE TABLE IF NOT EXISTS guidance_proposal (
    id VARCHAR PRIMARY KEY,
    proposal VARCHAR NOT NULL,  -- ref -> proposal (was: REFERENCE ON DELETE CASCADE)
    file_target VARCHAR NOT NULL,
    -- e.g. "CLAUDE.md", "~/.claude/CLAUDE.md"
    section VARCHAR,
    suggested_text VARCHAR NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_proposal_uq ON guidance_proposal(proposal);

CREATE TABLE IF NOT EXISTS automation_proposal (
    id VARCHAR PRIMARY KEY,
    proposal VARCHAR NOT NULL,  -- ref -> proposal (was: REFERENCE ON DELETE CASCADE)
    trigger_signal VARCHAR NOT NULL,
    schedule VARCHAR,
    -- cron expression, "weekly", etc; null = event-driven
    action VARCHAR NOT NULL,
    recovery_path VARCHAR,
    smoke_test_command VARCHAR,
    disable_command VARCHAR,
    failure_mode VARCHAR
    -- fail_open | fail_closed
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_proposal_uq ON automation_proposal(proposal);

-- ==== Typed evidence edges ====
-- Replaces the JSON-blob `evidence_refs` design that codex review flagged
-- as foreclosing the most important query: "which friction events have
-- not yet produced a proposal?" Heterogeneous source/target follows the
-- existing `derived_from` / `concerns` pattern (RELATION SCHEMAFULL).
-- `in` = the citing record (proposal | classifier_result - both are real
-- writers, see apps/axctl/src/classifiers/repository.ts and
-- apps/axctl/src/ingest/derive-proposals.ts), `out` = the cited evidence
-- record (friction_event | command_outcome | skill_candidate |
--  hook_command_invocation | spawned | turn | classifier_graph_node | ...).
-- BOTH sides are polymorphic (P1-1), so both get an explicit table column.
CREATE TABLE IF NOT EXISTS cites_evidence (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    in_table VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    count BIGINT NOT NULL DEFAULT 1,
    kind VARCHAR,
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS cites_evidence_in ON cites_evidence(in_id);
CREATE INDEX IF NOT EXISTS cites_evidence_out ON cites_evidence(out_id);
CREATE INDEX IF NOT EXISTS cites_evidence_in_out ON cites_evidence(in_id, out_id);

-- ==== Experiment (created on accept) ====
-- One row per accepted proposal. `artifact` is a typed link to the
-- created skill row when form=skill; `artifact_path` carries the
-- on-disk path for hook/guidance/automation forms. `scaffolded_at`
-- records when the CLI wrote the stub file (Phase C3 scaffold-on-accept
-- fix for the manual-step dropout problem).
CREATE TABLE IF NOT EXISTS experiment (
    id VARCHAR PRIMARY KEY,
    proposal VARCHAR NOT NULL,  -- ref -> proposal (was: REFERENCE ON DELETE CASCADE)
    artifact VARCHAR,  -- ref -> skill
    artifact_path VARCHAR,
    scaffolded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_verdict VARCHAR,
    status VARCHAR NOT NULL DEFAULT 'task_emitted',
    -- task_emitted | scaffolded | regressed | retired
    task_path VARCHAR
    -- absolute path to .ax/tasks/<id>.md while pending
);
CREATE INDEX IF NOT EXISTS experiment_status_idx ON experiment(status);
CREATE UNIQUE INDEX IF NOT EXISTS experiment_proposal_uq ON experiment(proposal);
CREATE INDEX IF NOT EXISTS experiment_created ON experiment(created_at);

-- ==== Opportunity (verdict denominator) ====
-- Each time a proposal's trigger pattern recurs after experiment.created_at,
-- emit one row. `was_addressed` flips true when the experiment's artifact
-- was invoked/applied near the match (per-form definition in the plan doc).
-- Verdict math at checkpoint time is `addressed / opportunities` per window.
-- Modeled as a RELATION (in = experiment, out = matched evidence record)
-- so the heterogeneous evidence target works the same way as cites_evidence.
-- Only `out` is polymorphic (P1-1): the writer
-- (apps/axctl/src/ingest/derive-opportunities.ts buildOpportunityStatements)
-- always relates FROM a fixed `experiment:` record, so `in_table` would be a
-- constant column and is intentionally omitted.
CREATE TABLE IF NOT EXISTS opportunity (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    matched_at TIMESTAMPTZ NOT NULL,
    was_addressed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS opportunity_in_ts ON opportunity(in_id, matched_at);
CREATE INDEX IF NOT EXISTS opportunity_out ON opportunity(out_id);
CREATE INDEX IF NOT EXISTS opportunity_in ON opportunity(in_id);

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
CREATE TABLE IF NOT EXISTS checkpoint (
    id VARCHAR PRIMARY KEY,
    experiment VARCHAR NOT NULL,  -- ref -> experiment (was: REFERENCE ON DELETE CASCADE)
    kind VARCHAR NOT NULL,
    -- current: +3s | +10s | +30s | adhoc
    -- legacy:  t+7 | t+30 | t+90 (calendar-day windows, pre-#83)
    -- measured: JSON-encoded object {opportunities, addressed, ratio, built,
    -- current_frequency, baseline_frequency} - was TYPE object with typed
    -- sub-fields (DuckDB has no nested-field DEFINE, folded to one JSON column)
    -- Frequency disambiguation for opportunities=0 verdicts: if the cluster
    -- frequency has grown since the proposal was accepted, the artifact is
    -- being ignored (still firing). Otherwise the pattern self-resolved.
    measured VARCHAR NOT NULL,  -- JSON
    suggested VARCHAR,
    -- adopted | ignored | regressed | no_longer_needed | partial
    user_verdict VARCHAR,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS checkpoint_experiment_kind ON checkpoint(experiment, kind, observed_at);

-- ==== dogfood_run (Phase C12) ====
-- One row per dogfood scenario invocation. Owned by src/dogfood/wterm.ts.
CREATE TABLE IF NOT EXISTS dogfood_run (
    id VARCHAR PRIMARY KEY,
    run_id VARCHAR NOT NULL,
    scenario VARCHAR NOT NULL,
    driver VARCHAR NOT NULL,       -- wterm | future drivers
    status VARCHAR NOT NULL,       -- passed | failed | error
    agent VARCHAR,
    command VARCHAR,
    command_source VARCHAR,
    transport VARCHAR,
    requested_transport VARCHAR,
    transport_fallback_reason VARCHAR,
    success_marker VARCHAR,
    marker_found BOOLEAN NOT NULL DEFAULT FALSE,
    timed_out BOOLEAN NOT NULL DEFAULT FALSE,
    timeout_seconds BIGINT,
    transcript_artifact VARCHAR,  -- ref -> artifact
    cwd VARCHAR,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS dogfood_run_id_uq ON dogfood_run(run_id);
CREATE INDEX IF NOT EXISTS dogfood_run_status_ts ON dogfood_run(status, ended_at);
CREATE INDEX IF NOT EXISTS dogfood_run_scenario ON dogfood_run(scenario, ended_at);

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
CREATE TABLE IF NOT EXISTS retro (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session (was: REFERENCE ON DELETE CASCADE)
    source VARCHAR NOT NULL,
    tried VARCHAR NOT NULL,
    worked VARCHAR,
    failed VARCHAR,
    next VARCHAR,
    raw VARCHAR,        -- original JSON payload
    repository VARCHAR,  -- ref -> repository
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS retro_session_uq ON retro(session);
CREATE INDEX IF NOT EXISTS retro_source_ts ON retro(source, created_at);
CREATE INDEX IF NOT EXISTS retro_repository_ts ON retro(repository, created_at);

-- Graph edge: session got a retro. Lets queries traverse both directions
-- (session->reviewed->retro, retro<-reviewed<-session) and ask
-- `WHERE count(->reviewed) = 0` for the pending-retro queue powering
-- `ax retro pending`. Bidirectional + reads cleanly in English.
CREATE TABLE IF NOT EXISTS reviewed (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS reviewed_in ON reviewed(in_id);
CREATE INDEX IF NOT EXISTS reviewed_out ON reviewed(out_id);
CREATE UNIQUE INDEX IF NOT EXISTS reviewed_in_out_uq ON reviewed(in_id, out_id);

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
-- Also reused (2026-06-02, hypothesis 007) as a per-repo git watermark:
-- source_kind='git_repo', path=repo root, sha=last-ingested HEAD, since_days=
-- the history window walked. If HEAD+since_days are unchanged the git stage
-- skips re-walking that repo's history (its commits/files already persist).
CREATE TABLE IF NOT EXISTS ingest_file_state (
    id VARCHAR PRIMARY KEY,
    path VARCHAR NOT NULL,
    source_kind VARCHAR NOT NULL,       -- e.g. "claude_transcript" | "git_repo"
    mtime_ms DOUBLE,
    size DOUBLE,
    sha VARCHAR,  -- git HEAD watermark
    since_days DOUBLE,  -- git history window walked
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ingest_file_state_path_uq ON ingest_file_state(path);
CREATE INDEX IF NOT EXISTS ingest_file_state_source ON ingest_file_state(source_kind);

-- ---------------------------------------------------------------------------
-- OTLP telemetry tables (2026-06-15)
-- Stores harness-push metric data points and trace spans received via the
-- /v1/metrics and /v1/traces OTLP/JSON receiver endpoints. Linked to the
-- session graph via the telemetry_of relation. `attrs` is JSON-encoded
-- key-value attributes from the OTLP payload. Tables index session_id (for the
-- telemetry-enriched rollups) and observed_at (for the incremental correlation
-- pass that windows recent telemetry). Index builds are CONCURRENTLY: a plain
-- DEFINE INDEX takes a table lock while it builds, which wedges the daemon when
-- re-applied to an already-large otel_log_event (codex emits ~1.5M log rows);
-- CONCURRENTLY builds in the background without locking.
-- (DuckDB has no CONCURRENTLY index build; the concurrency note is historical.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otel_metric_point (
    id VARCHAR PRIMARY KEY,
    harness VARCHAR NOT NULL,
    metric VARCHAR NOT NULL,
    value DOUBLE NOT NULL,
    unit VARCHAR,
    session_id VARCHAR,
    model VARCHAR,
    skill_name VARCHAR,
    agent_name VARCHAR,
    attrs VARCHAR,   -- JSON-encoded
    observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS otel_metric_session ON otel_metric_point(session_id);
CREATE INDEX IF NOT EXISTS otel_metric_observed ON otel_metric_point(observed_at);

CREATE TABLE IF NOT EXISTS otel_span (
    id VARCHAR PRIMARY KEY,
    harness VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    trace_id VARCHAR NOT NULL,
    span_id VARCHAR NOT NULL,
    parent_span_id VARCHAR,
    session_id VARCHAR,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    duration_ms DOUBLE NOT NULL,
    attrs VARCHAR,        -- JSON-encoded
    observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS otel_span_session ON otel_span(session_id);
CREATE INDEX IF NOT EXISTS otel_span_observed ON otel_span(observed_at);

CREATE TABLE IF NOT EXISTS otel_log_event (
    id VARCHAR PRIMARY KEY,
    harness VARCHAR NOT NULL,
    event_name VARCHAR NOT NULL,
    session_id VARCHAR,
    model VARCHAR,
    input_tokens DOUBLE,
    output_tokens DOUBLE,
    reasoning_tokens DOUBLE,
    cached_tokens DOUBLE,
    tool_tokens DOUBLE,
    duration_ms DOUBLE,
    status_code DOUBLE,
    attrs VARCHAR,
    observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS otel_log_event_session ON otel_log_event(session_id);
CREATE INDEX IF NOT EXISTS otel_log_event_observed ON otel_log_event(observed_at);

CREATE TABLE IF NOT EXISTS harness_tool_event (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    harness VARCHAR NOT NULL,
    event_kind VARCHAR NOT NULL,
    tool_name VARCHAR,
    tool_call VARCHAR,  -- ref -> tool_call
    provider_event VARCHAR,  -- ref -> agent_event
    otel_event VARCHAR,  -- ref -> otel_log_event
    prompt_id VARCHAR,
    tool_use_id VARCHAR,
    decision VARCHAR,
    decision_source VARCHAR,
    success BOOLEAN,
    error_type VARCHAR,
    duration_ms DOUBLE,
    attrs VARCHAR,
    observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS harness_tool_event_session ON harness_tool_event(session);
CREATE INDEX IF NOT EXISTS harness_tool_event_kind ON harness_tool_event(event_kind);

CREATE TABLE IF NOT EXISTS harness_run_context (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    harness VARCHAR NOT NULL,
    surface VARCHAR,
    entrypoint VARCHAR,
    deployment_provider VARCHAR,
    auth_mode VARCHAR,
    model_provider VARCHAR,
    model VARCHAR,
    reasoning_effort VARCHAR,
    reasoning_summary VARCHAR,
    approval_policy VARCHAR,
    sandbox_policy VARCHAR,
    permission_profile VARCHAR,
    web_search_mode VARCHAR,
    mcp_servers VARCHAR,
    app_version VARCHAR,
    terminal_type VARCHAR,
    source_event VARCHAR,  -- ref -> otel_log_event
    attrs VARCHAR,
    observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS harness_run_context_session ON harness_run_context(session);
CREATE INDEX IF NOT EXISTS harness_run_context_harness ON harness_run_context(harness);

-- ---------------------------------------------------------------------------
-- wrapped_card - agent-authored Wrapped recap cards (improve-first dashboard
-- PR4). `ax wrapped generate` emits a brief; an agent mines the graph and
-- publishes 10-16 headline cards via `ax wrapped publish` (full replace).
-- The dashboard serves them merged onto /api/wrapped; `sensitivity =
-- 'sensitive'` cards are dropped from the public preview.
CREATE TABLE IF NOT EXISTS wrapped_card (
    id VARCHAR PRIMARY KEY,
    question VARCHAR NOT NULL,   -- eyebrow, e.g. "Which archetype are you?"
    headline VARCHAR NOT NULL,   -- the big line, <=6 words
    body VARCHAR NOT NULL,   -- <=2 supporting lines
    sensitivity VARCHAR NOT NULL DEFAULT 'public',  -- public | sensitive
    "position" BIGINT NOT NULL DEFAULT 0,
    series DOUBLE[] NOT NULL DEFAULT [],  -- P2-3: native list, not JSON
    -- optional grounding sparkline - REAL data points (e.g. daily sessions
    -- on the card's model), rendered as the card's bar strip
    series_label VARCHAR,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- telemetry_of - session -> otel telemetry row edges (2026-06-15)
-- Drawn at ingest during the correlation pass that matches session_id on
-- otel_metric_point / otel_span rows back to normalized session records.
-- TYPE RELATION without FROM/TO constraints: the heterogeneous target
-- (otel_metric_point | otel_span) follows the same pattern as `concerns`
-- and `cites_evidence` (unconstrained polymorphic relations). Union-target
-- syntax (FROM session TO otel_metric_point | otel_span) is not used
-- elsewhere in this schema; omitting it is the safe, consistent choice.
-- Only `out` is polymorphic (P1-1): the writer
-- (apps/axctl/src/otel/correlate.ts) always relates FROM a fixed `session:`
-- record, so `in_table` would be a constant column and is intentionally
-- omitted; `out_table` records which otel_* table the linked row lives in.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_of (
    id VARCHAR PRIMARY KEY,
    in_id VARCHAR NOT NULL,
    out_id VARCHAR NOT NULL,
    out_table VARCHAR NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS telemetry_of_in ON telemetry_of(in_id);
CREATE INDEX IF NOT EXISTS telemetry_of_out ON telemetry_of(out_id);

-- ---------------------------------------------------------------------------
-- Run evidence ledger (#578) - a metadata-only overlay on the normalized graph.
-- It does NOT re-parse harnesses; it normalizes facts already in `turn`,
-- `tool_call`, `agent_event`, `plan_snapshot`, `compaction`, `command_outcome`,
-- and hook tables into a single queryable, reviewer-facing ledger that answers,
-- for a run: objective, durable task state, tool-backed observations, verifier
-- results, policy decisions, and what was lost at compaction/resume boundaries.
--
-- Two invariants:
--   1. Refs + hashes by default, never raw private payloads (privacy_level).
--   2. `backing` is verifier-DERIVED from available joins, not a producer trust
--      label - repeated claims never become observations, policy permission is
--      not proof of execution. No automatic promotion.
-- Rows are rebuildable: the key is derived from (session, source_table,
-- source_id) so re-deriving overwrites in place (idempotent UPSERT).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_evidence_event (
    id VARCHAR PRIMARY KEY,
    session VARCHAR NOT NULL,  -- ref -> session
    root_session VARCHAR,  -- ref -> session
    parent_session VARCHAR,  -- ref -> session
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    provider VARCHAR NOT NULL,
    -- objective|task_state|tool_observation|verification|policy_decision|boundary|artifact_ref|repo_state|claim|derived_summary
    kind VARCHAR NOT NULL,
    -- model_claim|tool_backed|verifier_backed|policy_backed|derived|unknown
    backing VARCHAR NOT NULL,
    -- Optional hot refs into the normalized graph (kept as links for traversal).
    turn VARCHAR,  -- ref -> turn
    tool_call VARCHAR,  -- ref -> tool_call
    agent_event VARCHAR,  -- ref -> agent_event
    compaction VARCHAR,  -- ref -> compaction
    plan_snapshot VARCHAR,  -- ref -> plan_snapshot
    command_outcome VARCHAR,  -- ref -> command_outcome
    hook_invocation VARCHAR,  -- ref -> hook_command_invocation
    artifact VARCHAR,  -- ref -> artifact
    file VARCHAR,  -- ref -> file
    checkout VARCHAR,  -- ref -> checkout
    "commit" VARCHAR,  -- ref -> commit
    -- Provenance back to the source row this evidence was normalized from.
    source_table VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    summary VARCHAR,
    content_hash VARCHAR,
    input_hash VARCHAR,
    output_hash VARCHAR,
    attrs VARCHAR,  -- JSON-encoded
    observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS run_evidence_event_session ON run_evidence_event(session, ts);
CREATE INDEX IF NOT EXISTS run_evidence_event_kind ON run_evidence_event(session, kind);
CREATE INDEX IF NOT EXISTS run_evidence_event_source ON run_evidence_event(source_table, source_id);
CREATE INDEX IF NOT EXISTS run_evidence_event_observed ON run_evidence_event(observed_at);

CREATE TABLE IF NOT EXISTS run_evidence_ref (
    id VARCHAR PRIMARY KEY,
    "event" VARCHAR NOT NULL,  -- ref -> run_evidence_event
    session VARCHAR NOT NULL,  -- ref -> session
    ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- record|file|sidecar|url|command|commit|external_event
    ref_kind VARCHAR NOT NULL,
    target_table VARCHAR,
    target_id VARCHAR,
    path_hash VARCHAR,
    uri_hash VARCHAR,
    content_hash VARCHAR,
    -- ref_only|hashed|summary|raw  (default ref_only - structural refs, no payload)
    privacy_level VARCHAR NOT NULL,
    attrs VARCHAR  -- JSON-encoded
);
CREATE INDEX IF NOT EXISTS run_evidence_ref_event ON run_evidence_ref("event");
CREATE INDEX IF NOT EXISTS run_evidence_ref_session ON run_evidence_ref(session, ts);
CREATE INDEX IF NOT EXISTS run_evidence_ref_target ON run_evidence_ref(target_table, target_id);
