-- ax judgment sidecar schema v2 - SQLite DDL.
--
-- WHAT LIVES HERE, AND WHY IT IS A SECOND FILE AT ALL. schema.duckdb.sql holds
-- the REBUILDABLE cache: every row in it is derived from files on disk
-- (transcripts, git, skills, the OTLP spool) and can be dropped and re-derived at
-- any time. The rows below cannot. They are DECISIONS - a proposal an agent
-- filed, a verdict a human locked, a role a user tagged a skill with, a retro
-- written at session end, a triage call, a label review, a dogfood result, a spar
-- stamp. Nothing on disk can reproduce them, so a cache rebuild must not be able
-- to touch them. Two files, two engines, one home per table: a table defined in
-- BOTH would let a reader answer from the empty one, which is precisely the
-- silent-wrong-answer the v2 no-fallback rule exists to prevent.
--
-- WHY SQLITE AND NOT MORE DUCKDB. The cache is opened read-only through a
-- published snapshot and written ONLY inside ingest under the ingest lock (see
-- packages/lib/src/duckdb/seam.ts). Judgment writes are REQUEST-TIME: `ax improve
-- accept`, `ax skills tag`, `ax retro emit`, a dashboard triage click. They do not
-- run inside ingest and must not have to take the ingest lock to record a
-- decision. SQLite is the right shape for that traffic - small, transactional,
-- concurrent-reader-safe under WAL, and already a Bun built-in.
--
-- WHAT MUST NOT MOVE IN HERE. Deterministic, re-derivable rows, however
-- decision-shaped they look. `feedback_case_type` / `feedback_case_result` are
-- backtest OUTPUT (`ax hooks cases`), `opportunity` is a mined denominator,
-- `cites_evidence` and `reviewed` are mined edges: all re-derive from the same
-- inputs, so all stay in the cache. The list of tables that DO belong here is
-- enumerated once, in sidecar-tables.ts, and sidecar-schema.test.ts asserts this
-- file creates exactly that set.
--
-- ROW IDS. Same contract as the cache: `id TEXT PRIMARY KEY`, a content hash of
-- the row's natural key (packages/lib/src/stable-id.ts). Never an autoincrement.
-- A judgment row also carries REFERENCES INTO THE CACHE (retro.session,
-- plays_role.in_id -> skill, experiment.artifact -> skill, ...) as plain TEXT
-- holding the cache row's id. Those are the refs that can dangle when a re-derive
-- drops a row, which is what packages/lib/src/cache-integrity.ts counts and what
-- makes the cache's byte-identical-id property load-bearing rather than tidy.
-- There are deliberately no FOREIGN KEYs to the cache - it is a different engine
-- - and none between sidecar tables either, for the same reason the cache has
-- none: writers arrive in whatever order the user acts in.
--
-- TYPES. SQLite has no BOOLEAN, no TIMESTAMP and no DOUBLE keyword worth using,
-- so the translation from schema.duckdb.sql is fixed and total:
--   VARCHAR   -> TEXT
--   BIGINT    -> INTEGER
--   DOUBLE    -> REAL
--   BOOLEAN   -> INTEGER, 0 or 1 (packages/lib/src/sqlite/columns.ts decodes it)
--   TIMESTAMP -> TEXT holding an ISO-8601 UTC instant, millisecond grain
--
-- TIMESTAMPS ARE ISO TEXT, NOT `CURRENT_TIMESTAMP`. SQLite's CURRENT_TIMESTAMP
-- renders `YYYY-MM-DD HH:MM:SS`: no `T`, no `Z`, no milliseconds. `new Date()` of
-- that string reads it as LOCAL time, so on any non-UTC host every default-stamped
-- row would come back hours off - the same class of defect the cache seam pins UTC
-- to prevent, arriving through the DDL instead of the connection. Every default
-- below is therefore `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, which is UTC by
-- definition ('now' is UTC in SQLite) and parses correctly everywhere.

-- ==== Proposals (the improve loop's shortlist) ====
-- One row per candidate improvement. `form` selects which typed payload table
-- below carries its form-specific fields. Written by `ax improve propose`
-- (origin='agent') and by the ingest miner (origin='mined'); status is moved by
-- `ax improve accept` / `reject` / `housekeep`.
CREATE TABLE IF NOT EXISTS proposal (
    id TEXT PRIMARY KEY,
    form TEXT NOT NULL,
    -- skill | subagent | hook | guidance | automation
    title TEXT NOT NULL,
    hypothesis TEXT NOT NULL,
    dedupe_sig TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 0,
    confidence TEXT NOT NULL,
    -- low | medium | high
    status TEXT NOT NULL DEFAULT 'open',
    -- open | accepted | rejected | superseded
    origin TEXT NOT NULL DEFAULT 'mined',
    -- mined (signal-derived) | agent (written via `ax improve propose`)
    hypothesis_template TEXT,
    -- hypothesis with {{placeholders}} hydrated at serve time from
    -- evidence_query's first row - numbers never expire
    evidence_query TEXT,
    -- read-only SQL (SELECT/RETURN only, validated at write AND serve)
    -- producing the row that fills hypothesis_template
    reject_reason TEXT,
    baseline TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS proposal_dedupe_uq ON proposal(dedupe_sig);
CREATE INDEX IF NOT EXISTS proposal_status_freq ON proposal(status, frequency);
CREATE INDEX IF NOT EXISTS proposal_form_status ON proposal(form, status, created_at);

-- ==== Per-form payload tables ====
-- One row per proposal of the matching form. Typed fields per form, rather than
-- a JSON blob on `proposal`, so a form's own fields stay queryable.
CREATE TABLE IF NOT EXISTS skill_proposal (
    id TEXT PRIMARY KEY,
    proposal TEXT NOT NULL,  -- ref -> proposal.id
    trigger_pattern TEXT NOT NULL,
    suspected_gap TEXT NOT NULL,
    proposed_behavior TEXT NOT NULL,
    expected_impact TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_proposal_uq ON skill_proposal(proposal);

CREATE TABLE IF NOT EXISTS subagent_proposal (
    id TEXT PRIMARY KEY,
    proposal TEXT NOT NULL,  -- ref -> proposal.id
    bounded_role TEXT NOT NULL,
    delegation_trigger TEXT NOT NULL,
    -- pattern matched against Task tool calls
    example_task_patterns TEXT NOT NULL DEFAULT '[]'  -- JSON-encoded string[]
);
CREATE UNIQUE INDEX IF NOT EXISTS subagent_proposal_uq ON subagent_proposal(proposal);

CREATE TABLE IF NOT EXISTS hook_proposal (
    id TEXT PRIMARY KEY,
    proposal TEXT NOT NULL,  -- ref -> proposal.id
    event_name TEXT NOT NULL,
    -- PreToolUse | PostToolUse | SessionStart | ...
    target_tool TEXT,
    hook_command TEXT NOT NULL,
    recovery_path TEXT,
    smoke_test_command TEXT,
    disable_command TEXT,
    failure_mode TEXT
    -- fail_open | fail_closed
);
CREATE UNIQUE INDEX IF NOT EXISTS hook_proposal_uq ON hook_proposal(proposal);

CREATE TABLE IF NOT EXISTS guidance_proposal (
    id TEXT PRIMARY KEY,
    proposal TEXT NOT NULL,  -- ref -> proposal.id
    file_target TEXT NOT NULL,
    -- e.g. "CLAUDE.md", "~/.claude/CLAUDE.md"
    section TEXT,
    suggested_text TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS guidance_proposal_uq ON guidance_proposal(proposal);

CREATE TABLE IF NOT EXISTS automation_proposal (
    id TEXT PRIMARY KEY,
    proposal TEXT NOT NULL,  -- ref -> proposal.id
    trigger_signal TEXT NOT NULL,
    schedule TEXT,
    -- cron expression, "weekly", etc; null = event-driven
    action TEXT NOT NULL,
    recovery_path TEXT,
    smoke_test_command TEXT,
    disable_command TEXT,
    failure_mode TEXT
    -- fail_open | fail_closed
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_proposal_uq ON automation_proposal(proposal);

-- ==== Experiment (created on accept) ====
-- One row per accepted proposal. `artifact` is the CACHE id of the created skill
-- row when form=skill; `artifact_path` carries the on-disk path for the
-- hook/guidance/automation forms.
CREATE TABLE IF NOT EXISTS experiment (
    id TEXT PRIMARY KEY,
    proposal TEXT NOT NULL,  -- ref -> proposal.id
    artifact TEXT,           -- ref -> cache skill.id
    artifact_path TEXT,
    scaffolded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    locked_verdict TEXT,
    status TEXT NOT NULL DEFAULT 'task_emitted',
    -- publishing | task_emitted | scaffolded | regressed | retired
    -- `publishing` is transient: the accept transaction has committed but the
    -- task brief is not on disk yet, so a retry finishes the publication instead
    -- of refusing it (see apps/axctl/src/improve/actions.ts).
    task_path TEXT
    -- absolute path to .ax/tasks/<id>.md while pending
);
CREATE INDEX IF NOT EXISTS experiment_status_idx ON experiment(status);
CREATE UNIQUE INDEX IF NOT EXISTS experiment_proposal_uq ON experiment(proposal);
CREATE INDEX IF NOT EXISTS experiment_created ON experiment(created_at);

-- ==== Checkpoint (decision support, never auto-verdict) ====
-- One row per (experiment, kind) snapshot. `measured` is the aggregate JSON,
-- `suggested` the algorithm's guess, `user_verdict` the human's answer - the
-- judgment this whole table exists to keep. Algorithm proposes, human decides.
CREATE TABLE IF NOT EXISTS checkpoint (
    id TEXT PRIMARY KEY,
    experiment TEXT NOT NULL,  -- ref -> experiment.id
    kind TEXT NOT NULL,
    -- current: +3s | +10s | +30s | adhoc ; legacy: t+7 | t+30 | t+90
    measured TEXT NOT NULL,  -- JSON object
    suggested TEXT,
    -- adopted | ignored | regressed | no_longer_needed | partial
    user_verdict TEXT,
    observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS checkpoint_experiment_kind ON checkpoint(experiment, kind, observed_at);

-- ==== Role registry + role tags ====
-- `role.weight` is a user-tuned number and `plays_role` is a user/agent
-- classification of a skill: both are judgment, and both are keyed against a
-- CACHE skill id, so both can dangle after a re-derive.
CREATE TABLE IF NOT EXISTS role (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0
);
CREATE UNIQUE INDEX IF NOT EXISTS role_name_uq ON role(name);

CREATE TABLE IF NOT EXISTS plays_role (
    id TEXT PRIMARY KEY,
    in_id TEXT NOT NULL,   -- ref -> cache skill.id
    out_id TEXT NOT NULL,  -- ref -> role.id
    confidence REAL NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL,
    weight REAL,
    rationale TEXT,
    since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS plays_role_in ON plays_role(in_id);
CREATE INDEX IF NOT EXISTS plays_role_out ON plays_role(out_id);
-- Source is part of the natural key. A user tag and a mined tag can classify
-- the same skill-role pair at the same time. Each writer removes only its own
-- source before it writes the current value.
CREATE UNIQUE INDEX IF NOT EXISTS plays_role_in_out_source_uq ON plays_role(in_id, out_id, source);

-- ==== Retro ====
-- A structured reflection emitted at session end: tried / worked / failed / next.
-- One retro per session; re-emitting overwrites, and `raw` preserves the original
-- payload for audit.
CREATE TABLE IF NOT EXISTS retro (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,  -- ref -> cache session.id
    source TEXT NOT NULL,
    -- claude_stop_hook | codex_rollout | heuristic | manual
    tried TEXT NOT NULL,
    worked TEXT,
    failed TEXT,
    next TEXT,
    raw TEXT,               -- original JSON payload
    repository TEXT,        -- ref -> cache repository.id
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS retro_session_uq ON retro(session);
CREATE INDEX IF NOT EXISTS retro_source_ts ON retro(source, created_at);
CREATE INDEX IF NOT EXISTS retro_repository_ts ON retro(repository, created_at);

-- ==== Skill triage decisions ====
-- The dashboard's keep/archive/review call on a skill, by NAME rather than by
-- cache id: the decision outlives an uninstall-and-reinstall of the skill.
CREATE TABLE IF NOT EXISTS skill_triage_decision (
    id TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL,
    decision TEXT NOT NULL,  -- keep | archive | review
    reason TEXT,
    decided_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_triage_decision_name ON skill_triage_decision(skill_name);

-- ==== Transcript label review ====
-- Reviewed-status provenance for mined label candidates: who reviewed a
-- candidate, what they decided, and whether it is safe to promote into the graph.
-- The candidate/vector/graph-fact rows themselves are mined and stay in the cache;
-- only the REVIEW is judgment.
CREATE TABLE IF NOT EXISTS transcript_label_review (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    graph_fact_id TEXT,
    label_family TEXT NOT NULL,
    review_status TEXT NOT NULL,
    promotion_safe INTEGER NOT NULL,  -- 0 | 1
    reviewed_label TEXT,
    reviewed_target TEXT,
    reviewer TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence_paths_json TEXT NOT NULL,  -- JSON-encoded string[]
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS transcript_label_review_candidate ON transcript_label_review(candidate_id);
CREATE INDEX IF NOT EXISTS transcript_label_review_graph_fact ON transcript_label_review(graph_fact_id);
CREATE INDEX IF NOT EXISTS transcript_label_review_family ON transcript_label_review(label_family);
CREATE INDEX IF NOT EXISTS transcript_label_review_status ON transcript_label_review(review_status);

-- ==== Dogfood runs ====
-- One row per dogfood scenario invocation: an observed pass/fail an agent or a
-- human acted on, and nothing on disk re-derives it once the terminal is gone.
CREATE TABLE IF NOT EXISTS dogfood_run (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    scenario TEXT NOT NULL,
    driver TEXT NOT NULL,       -- wterm | future drivers
    status TEXT NOT NULL,       -- passed | failed | error
    agent TEXT,
    command TEXT,
    command_source TEXT,
    transport TEXT,
    requested_transport TEXT,
    transport_fallback_reason TEXT,
    success_marker TEXT,
    marker_found INTEGER NOT NULL DEFAULT 0,  -- 0 | 1
    timed_out INTEGER NOT NULL DEFAULT 0,     -- 0 | 1
    timeout_seconds INTEGER,
    transcript_artifact TEXT,   -- ref -> cache artifact.id
    cwd TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS dogfood_run_id_uq ON dogfood_run(run_id);
CREATE INDEX IF NOT EXISTS dogfood_run_status_ts ON dogfood_run(status, ended_at);
CREATE INDEX IF NOT EXISTS dogfood_run_scenario ON dogfood_run(scenario, ended_at);

-- ==== Session labels (spar stamps) ====
-- The wave-3 list calls these "spar labels", and in v1 they were VALUES in
-- `session.labels` - a JSON column on the `session` row itself. That column is
-- rebuilt from the transcript on every re-derive, so `ax dojo spar-score`'s stamp
-- (which is what excludes a variant run from behavioural analytics) survived only
-- until the next ingest. Here it is a row of its own, keyed by the cache session
-- id, and the label is applied at READ time by the analytics that care.
-- Merge-union semantics come free: one row per (session, label).
CREATE TABLE IF NOT EXISTS session_label (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,  -- ref -> cache session.id
    label TEXT NOT NULL,
    source TEXT,               -- what applied it, e.g. "spar-score"
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS session_label_uq ON session_label(session_id, label);
CREATE INDEX IF NOT EXISTS session_label_label ON session_label(label);
