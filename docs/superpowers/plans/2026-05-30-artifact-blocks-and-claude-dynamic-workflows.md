# Artifact Blocks And Claude Dynamic Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared block/atom extraction layer for agent-produced artifacts, with saved Claude Code Dynamic Workflow scripts treated as first-class artifacts. ax should answer questions across GSD plans, Rough Loop/state files, skills, saved workflow scripts, verification reports, checklists, and file/reference atoms without regexing raw blobs at render time.

**Architecture:** Keep raw provider/session/artifact text lossless. Add typed `content_block` and `content_atom` records as the common searchable unit for `skill`, `artifact`, `plan_snapshot`, and saved workflow documents. Saved Claude workflow scripts are ingested as `artifact + content_document + content_block + content_atom` in v1. Runtime workflow fanout, all-provider turn blocks, symbol grounding, and phase/agent cost rollups remain part of this roadmap, but they are later phases gated by real artifacts, query evidence, and MVP stability.

**Testing posture:** This feature must be test-driven. Parsers/classifiers are treated as an extensible rules engine with fixture-backed golden tests, accepted/rejected cases, provenance, confidence scores, and backwards-compatible contribution points. Every new document style should be addable by contributing fixtures plus a parser/classifier module, not by editing dashboard regexes or provider-specific ingestion code.

**Primary reference:** Claude Code Dynamic Workflows docs: https://code.claude.com/docs/en/workflows

---

## MVP Scope

Ship this first:

- Generic `content_document`, `content_block`, and `content_atom` persistence.
- Parser/classifier registry with versioned parse fingerprints.
- Fixture-backed tests with accepted and rejected cases.
- Artifact discovery from explicit allowlisted roots.
- Parsers for:
  - GSD state files
  - GSD plan files
  - GSD verification files
  - `SKILL.md`
  - saved Claude workflow scripts as static artifacts
- Atom extraction for:
  - `frontmatter_field`
  - `checklist_item`
  - `task_node`
  - `verification_command`
  - `file_ref`
  - `url_ref`
  - `command_ref`
  - `plan_ref`
  - `requirement_ref`
  - `commit_ref`
  - unresolved `symbol_ref`
- Query surface for:
  - listing parsed artifacts
  - searching searchable blocks
  - listing unchecked checklist items
  - listing file refs
  - listing skill triggers/resources

## Later Phases In This Roadmap

Do not implement these in the MVP, but keep them as planned follow-on workload:

- Claude Dynamic Workflow runtime tables or run ingestion.
- Workflow phase/agent token and cost rollups.
- All-provider turn block backfill.
- AST-backed symbol resolution.
- Dashboard rewrite.
- Broad repo-wide globbing beyond explicit artifact roots.

These phases start after MVP fixtures and query behavior are stable. They are not cut; they are sequenced behind gates so the first slice does not fossilize speculative schema or parser assumptions.

---

## Current Context

- Existing schema already has `agent_provider`, `agent_session`, `agent_event`, `turn`, `tool_call`, `plan`, `plan_item`, `plan_snapshot`, `artifact`, `session_token_usage`, `agent_model`, and `used_model`.
- Existing plan ingestion normalizes Claude TodoWrite and Codex `update_plan`, but only as plan snapshots/items.
- Existing FTS is mostly on `turn.text_excerpt`, commit messages, skill name/description, and file memories.
- The prototype at `docs/prototypes/turn-text-architecture-prototype.html` shows the target mental model.
- This plan should not delete raw `turn.text`, `artifact.raw`, provider events, or raw transcript buckets.

## Terms

- **Content document:** a source container that can be split into typed blocks. Examples: turn text, `SKILL.md`, `.planning/STATE.md`, GSD `*-PLAN.md`, `*-VERIFICATION.md`, saved Claude workflow script.
- **Content block:** a typed span/section extracted from a document. Examples: `frontmatter`, `heading`, `task_node`, `checklist_item`, `verification_section`, `file_ref_context`.
- **Content atom:** a smaller extracted fact/reference from a block. Examples: `file_ref`, `url_ref`, `symbol_ref`, `requirement_ref`, `workflow_trigger`, `checklist_status`, `frontmatter_field`.
- **Claude Dynamic Workflow:** Claude Code generated JavaScript orchestration that runs subagents in the background, appears in `/workflows`, and can be saved under `.claude/workflows/` or `~/.claude/workflows/`. MVP ingests saved scripts only. Runtime run/phase/agent records require a real-artifact discovery gate.

---

## File Structure

- Modify `schema/schema.surql`
  - Add `content_document`, `content_block`, `content_atom`.
  - Add explicit relation tables from atoms to files, commits, models, and artifacts only where MVP query paths require them.
- Create `src/ingest/content-blocks/types.ts`
- Create `src/ingest/content-blocks/registry.ts`
- Create `src/ingest/content-blocks/parse-markdown.ts`
- Create `src/ingest/content-blocks/parse-yaml.ts`
- Create `src/ingest/content-blocks/parse-js-workflow.ts`
- Create `src/ingest/content-blocks/extract-atoms.ts`
- Create `src/ingest/content-blocks/persist.ts`
- Create `src/ingest/content-blocks/*.test.ts`
- Create `src/ingest/content-blocks/fixtures/**`
- Create `src/ingest/content-blocks/golden/**`
- Create `src/ingest/artifacts.ts`
  - Discovers and ingests planning docs, skills, saved workflows, YAML/JSON state files.
- Create `src/ingest/claude-workflows.ts`
  - Discovers saved workflow scripts only.
- Modify `src/ingest/skills.ts`
  - Persist `SKILL.md` frontmatter/body blocks and resource refs.
- Modify `src/ingest/stage/registry.ts`
  - Add stages: `content-blocks`, `artifacts`, `claude-workflows`.
- Modify query/dashboard files
  - Add block search and artifact list. Runtime workflow views and cost rollups are deferred.

---

## Phase 1: Shared Content Block Schema

**Files:**
- Modify `schema/schema.surql`
- Create `src/ingest/content-blocks/types.ts`
- Create `src/ingest/content-blocks/registry.ts`
- Create `src/ingest/content-blocks/persist.ts`
- Create `src/ingest/content-blocks/persist.test.ts`

- [ ] **Step 1: Add content document/block/atom schema**

Add schema tables:

```surql
DEFINE TABLE content_document SCHEMAFULL;
DEFINE FIELD source_kind    ON content_document TYPE string; -- turn | skill | artifact | plan_snapshot | workflow_script | workflow_run
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
DEFINE FIELD parse_fingerprint ON content_document TYPE string; -- registry + parser/classifier versions + content hash
DEFINE FIELD registry_version ON content_document TYPE string;
DEFINE FIELD parser_id      ON content_document TYPE string;
DEFINE FIELD parser_version ON content_document TYPE string;
DEFINE FIELD classifier_versions ON content_document TYPE option<string>; -- JSON-encoded
DEFINE FIELD blockset_hash  ON content_document TYPE option<string>;
DEFINE FIELD raw_text       ON content_document TYPE option<string>; -- only for small, non-duplicated artifacts
DEFINE FIELD raw            ON content_document TYPE option<string>; -- JSON-encoded
DEFINE FIELD labels         ON content_document TYPE option<string>; -- JSON-encoded
DEFINE FIELD metrics        ON content_document TYPE option<string>; -- JSON-encoded
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
DEFINE FIELD search_text    ON content_block TYPE option<string>; -- capped/indexed text for searchable block kinds
DEFINE FIELD block_hash     ON content_block TYPE string;
DEFINE FIELD start_offset   ON content_block TYPE option<int>;
DEFINE FIELD end_offset     ON content_block TYPE option<int>;
DEFINE FIELD confidence     ON content_block TYPE float DEFAULT 1.0;
DEFINE FIELD parser         ON content_block TYPE string;
DEFINE FIELD raw            ON content_block TYPE option<string>; -- JSON-encoded
DEFINE FIELD labels         ON content_block TYPE option<string>; -- JSON-encoded
DEFINE FIELD metrics        ON content_block TYPE option<string>; -- JSON-encoded
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
DEFINE FIELD raw            ON content_atom TYPE option<string>; -- JSON-encoded
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
```

- [ ] **Step 2: Add statement builders**

Implement stable record IDs:

- `content_document:{sourceKind}__{sourceRefHash}`
- `content_block:{documentKey}__{seq}`
- `content_atom:{blockKey}__{kind}__{seq}`

Rules:

- JSON-encode nested `raw`, `labels`, and `metrics`.
- Keep `raw_text` only for small documents that are not already stored elsewhere. For turns, existing `turn.text` remains the source of truth.
- Keep `text_excerpt` always. Full `text` is optional/pointer-backed for large blocks.
- Populate `search_text` only for searchable block kinds and cap it before FTS indexing.
- `raw`, `labels`, and `metrics` are display/debug fields. Anything used for filtering or rollups must be promoted to a typed top-level field plus index.
- Reparse when `content_hash`, parser version, classifier version, or registry version changes.
- Use `block_hash` to diff changed documents. Rewrite changed blocks and their atoms; delete missing block hashes. Do not rewrite every block on small checklist edits.

- [ ] **Step 3: Tests**

Add tests proving:

- Documents/blocks/atoms get stable IDs.
- A block can reference a `turn`, `skill`, `artifact`, or `plan_snapshot`.
- FTS index exists in schema.
- Re-ingesting same document hash rewrites the same block IDs.

- [ ] **Step 4: Add parser/classifier registry**

Create a small registry contract:

```ts
export type ContentParser = {
    readonly id: string;
    readonly version: string;
    readonly accepts: (input: ContentDocumentInput) => ParserDecision;
    readonly parse: (input: ContentDocumentInput) => ParsedContentDocument;
};

export type ParserDecision = {
    readonly decision: "accept" | "reject" | "maybe";
    readonly score: number;
    readonly reason: string;
};

export type AtomClassifier = {
    readonly id: string;
    readonly version: string;
    readonly kinds: readonly string[];
    readonly classify: (block: ParsedContentBlock) => readonly ParsedContentAtom[];
};
```

Rules:

- Parser order and conflict resolution are explicit and tested.
- Parsers must emit `parser`, `confidence`, and `raw.provenance`.
- Parsers return accept/maybe/reject with a score and reason; rejected attempts are testable and optionally persisted as diagnostics.
- New open-source contributions add a parser/classifier plus fixtures, not conditionals in core ingestion.

---

## Phase 1.5: Fixture Corpus And Golden Tests

**Files:**
- Create `src/ingest/content-blocks/fixtures/README.md`
- Create `src/ingest/content-blocks/fixtures/{provider}/{case}.input.*`
- Create `src/ingest/content-blocks/golden/{provider}/{case}.blocks.json`
- Create `src/ingest/content-blocks/golden/{provider}/{case}.atoms.json`
- Create `src/ingest/content-blocks/fixtures.test.ts`

- [ ] **Step 1: Define fixture layout**

Fixture families:

- `turns/claude`
- `turns/codex`
- `turns/pi`
- `turns/opencode`
- `turns/cursor`
- `artifacts/gsd`
- `artifacts/rough-loop`
- `artifacts/skills`
- `artifacts/claude-workflows`
- `artifacts/monitoring`
- `artifacts/github-actions`
- `artifacts/kubernetes`

Each fixture includes:

- input file
- metadata JSON: source kind, expected parser, expected accepted/rejected status
- golden blocks JSON
- golden atoms JSON
- optional rejected-attempts JSON

- [ ] **Step 2: Add accepted and rejected examples**

For every parser, include both:

- accepted examples: documents it should own
- rejected examples: similar-looking documents it must not classify

Examples:

- GSD plan parser accepts `.planning/quick/*/*-PLAN.md`.
- GSD plan parser rejects a generic README with checkboxes.
- Skill parser accepts `SKILL.md` with frontmatter.
- Skill parser rejects ordinary markdown that mentions “skill”.
- Claude workflow parser accepts saved workflow JS.
- Claude workflow parser rejects unrelated app workflow source unless explicitly handled by an Effect Workflow parser.

- [ ] **Step 3: Semantic golden output tests**

Semantic golden tests compare required facts, not full unstable arrays:

- block `kind`
- heading
- atom `kind`
- atom normalized value
- parser id/version
- stable semantic key

Keep one or two strict renderer/order golden tests per parser for display stability. Do not assert exact offsets until parsers are stable; offsets get their own focused tests.

- [ ] **Step 4: Corpus growth workflow**

When ax sees an unknown document style:

1. Store a redacted fixture candidate.
2. Record parser rejection reasons.
3. Add a failing golden test describing the expected blocks/atoms.
4. Implement or extend a parser.
5. Keep the fixture forever as regression coverage.

This is the main open-source contribution path.

- [ ] **Step 5: Add fixture redaction and contribution contract**

Add:

- `bun ax fixture:redact <path>`
- fixture manifest schema
- allowed/forbidden fixture fields
- contributor checklist

Fixtures must not include secrets, private customer data, private repo names, or raw proprietary transcripts. Redaction should preserve structure, headings, refs, and parser-triggering syntax.

---

## Phase 2: Markdown/YAML/JSON Artifact Parsing

**Files:**
- Create `src/ingest/content-blocks/parse-markdown.ts`
- Create `src/ingest/content-blocks/parse-yaml.ts`
- Create `src/ingest/content-blocks/extract-atoms.ts`
- Create tests with fixtures from quera-style docs.

- [ ] **Step 1: Markdown parser**

Parse markdown into block kinds:

- `frontmatter`
- `heading`
- `paragraph`
- `code_fence`
- `blockquote`
- `table`
- `checklist_item`
- `xml_section`
- `task_node`
- `verification_section`
- `success_criteria`
- `output_artifact`

Use a markdown parser if one is already available; otherwise implement a small line-oriented parser with tests and keep it conservative.

- [ ] **Step 2: YAML/JSON parser**

Parse:

- YAML frontmatter from `SKILL.md`, GSD plan files, state files.
- JSON config/progress files like `.planning/config.json`.
- Rough Loop-style todo/progress YAML if discovered.

Emit atom kinds:

- `frontmatter_field`
- `status_field`
- `progress_counter`
- `todo_item`
- `todo_status_transition`
- `dependency_ref`
- `model_profile`
- `workflow_flag`

- [ ] **Step 3: Generic atom extraction**

Extract atoms from any block:

- `file_ref`
- `url_ref`
- `symbol_ref`
- `command_ref`
- `package_ref`
- `requirement_ref`
- `plan_ref`
- `commit_ref`
- `branch_ref`
- `risk_item`
- `decision_item`
- `evidence_row`

Keep confidence/provenance:

- `confidence=1.0` for structured fields.
- `confidence=0.7` for regex-detected refs.
- `raw.parser_reason` explains which rule fired.

---

## Phase 3: Artifact Discovery Stage

**Files:**
- Create `src/ingest/artifacts.ts`
- Create `src/ingest/artifacts.test.ts`
- Modify `src/ingest/stage/registry.ts`
- Modify `src/lib/config.ts` if needed.

- [ ] **Step 1: Discover artifact roots**

MVP scans only explicit allowlisted roots:

- `.planning/**/*.md`
- `.planning/**/*.{yaml,yml,json}`
- `.claude/monitoring/**/*.md`
- `.claude/workflows/**/*.{js,mjs,ts}`
- `docs/superpowers/plans/**/*.md`
- configured skill roots only

Ignore:

- `node_modules`
- `.git`
- nested git repositories
- generated dependency caches
- nested worktrees unless configured as separate workspace roots
- symlink loops
- binary files
- files over the configured max size

Add discovery dry-run output before ingest:

- files considered
- files accepted
- files rejected
- files skipped by ignore rule
- total bytes
- largest files

- [ ] **Step 2: Test discovery boundaries**

Add tests for:

- symlinks
- nested git repos
- `.claude/worktrees`
- `node_modules`
- max file size
- binary files
- ignored dirs
- workspace-root boundaries
- configured skill roots vs project artifact roots

- [ ] **Step 3: Classify artifact documents**

Artifact kinds:

- `gsd_state`
- `gsd_plan`
- `gsd_verification`
- `gsd_summary`
- `monitoring_rca`
- `superpowers_plan`
- `skill`
- `rough_loop_state`
- `json_config`
- `claude_workflow_script`
- `unknown_markdown`

- [ ] **Step 4: Persist blocks and atoms**

For each discovered artifact:

1. Upsert `artifact`.
2. Upsert `content_document`.
3. Compare `parse_fingerprint` and `blockset_hash`.
4. Rewrite changed blocks by `block_hash`, not the whole document when possible.
5. Persist atoms for changed blocks.
6. Relate atoms to file/commit/plan/artifact records where MVP query paths require it.

---

## Phase 4: Skills As Parsed Instruction Artifacts

**Files:**
- Modify `src/ingest/skills.ts`
- Add `src/ingest/skills-blocks.test.ts`

- [ ] **Step 1: Parse `SKILL.md` frontmatter and body**

Persist:

- `frontmatter.name`
- `frontmatter.description`
- `metadata.short-description`
- headings
- trigger language: `Use when`, `Trigger`, “must use”
- workflow/process steps
- validation/checklist sections
- resource references: `references/*`, `scripts/*`, `assets/*`

- [ ] **Step 2: Add skill edges**

Atom kinds:

- `skill_trigger`
- `procedure_step`
- `resource_ref`
- `script_ref`
- `asset_ref`
- `reference_doc_ref`

Edges:

- `skill -> content_document`
- `content_atom(resource_ref) -> artifact/path`
- future: `session -> skill` already exists through invocation; keep this separate from static definition.

---

## Phase 5: Claude Dynamic Workflow Static Script Ingestion

**Files:**
- Create `src/ingest/claude-workflows.ts`
- Create `src/ingest/content-blocks/parse-js-workflow.ts`
- Create `src/ingest/claude-workflows.test.ts`
- Modify `schema/schema.surql`

- [ ] **Step 1: Add workflow script schema**

```surql
DEFINE TABLE claude_workflow_script SCHEMAFULL;
DEFINE FIELD name           ON claude_workflow_script TYPE string;
DEFINE FIELD scope          ON claude_workflow_script TYPE string; -- project | user | bundled
DEFINE FIELD path           ON claude_workflow_script TYPE option<string>;
DEFINE FIELD command_name   ON claude_workflow_script TYPE option<string>;
DEFINE FIELD content_hash   ON claude_workflow_script TYPE string;
DEFINE FIELD document       ON claude_workflow_script TYPE option<record<content_document>>;
DEFINE FIELD raw_text       ON claude_workflow_script TYPE option<string>;
DEFINE FIELD labels         ON claude_workflow_script TYPE option<string>; -- JSON-encoded
DEFINE FIELD metrics        ON claude_workflow_script TYPE option<string>; -- JSON-encoded
DEFINE FIELD created_at     ON claude_workflow_script TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at     ON claude_workflow_script TYPE option<datetime>;
DEFINE INDEX claude_workflow_script_scope_name ON claude_workflow_script FIELDS scope, name UNIQUE;
DEFINE INDEX claude_workflow_script_hash ON claude_workflow_script FIELDS content_hash;
```

- [ ] **Step 2: Discover saved scripts**

Scan:

- `.claude/workflows/`
- `~/.claude/workflows/`

Rules:

- Project workflow wins over personal workflow when names collide.
- Saved script command is `/<name>`.
- Built-in `/deep-research` is modeled as `scope=bundled` even if no local script is present.

- [ ] **Step 3: Parse script blocks**

For JS/TS workflow scripts, extract best-effort:

- imports
- workflow name/metadata comments if present
- phase definitions
- agent spawn calls
- concurrency limits
- model routing hints
- prompt templates
- file/path refs
- tool names

Do not require perfect JS semantics in v1. If AST tooling is available, use it; otherwise line/block parsing is acceptable behind tests.

---

## Phase 6: Claude Dynamic Workflow Runtime Discovery Spike

**Files:**
- Create `docs/experiments/claude-dynamic-workflow-runtime-artifacts.md`
- Create redacted fixtures only after real local runtime artifacts are captured.

- [ ] **Step 1: Capture real runtime artifacts**

Do not add runtime schema in the MVP. First capture at least three redacted real Claude Code v2.1.154+ Dynamic Workflow runtime artifacts covering:

- prompt keyword workflow
- saved slash-command workflow
- `/deep-research` or ultracode workflow, if available

Search likely roots:

- `~/.claude/`
- project `.claude/`
- Claude Code task/session storage

Document:

- exact paths
- file formats
- stable IDs, if any
- whether phase/agent/token data is persisted locally
- whether pause/resume/stop/save lifecycle events are persisted locally
- privacy/redaction requirements

- [ ] **Step 2: Gate runtime ingestion**

Runtime workflow ingestion remains disabled behind `experimental` until:

- real redacted fixtures exist
- fixture tests pass
- the storage format is stable enough to parse
- the generic `content_document/block/atom` model proves insufficient for the required queries

- [ ] **Step 3: Decide schema after evidence**

Only after the discovery spike, choose one:

- ingest runtime artifacts as generic `content_document/block/atom` rows plus raw JSON
- add specialized workflow run/phase/agent tables
- skip runtime ingestion if Claude Code does not persist enough local state

If specialized runtime tables are added later, token/cost fields must preserve the same dimensions as `session_token_usage`: input, output, cache creation, cache read, model, pricing source, and pricing effective date. `token_total` can exist only as a cached display summary.

Runtime facts to look for:

- run name
- trigger kind: prompt keyword, ultracode, slash command, `/deep-research`, Agent SDK
- approval decision: once/always/deny if locally observable
- planned phase list
- phase status
- agent prompt
- recent tool calls
- agent result
- token totals
- elapsed time
- pause/resume/stop/restart/save lifecycle events
- saved command/script path

---

## Phase 7: MVP Query Surface

**Files:**
- Create/modify query modules under `src/queries/`
- Add CLI commands if useful.

- [ ] **Step 1: Block search**

Add query support:

- Search searchable blocks by BM25 using capped `search_text`.
- Filter by `source_kind`, `kind`, `artifact_kind`, workspace, and path.
- Return exact block matches with parent document/artifact context.
- Use canned fixture DB seeds with exact expected result IDs.

- [ ] **Step 2: Artifact explorer**

Show:

- active plans
- unchecked checklist items
- verification evidence
- skill triggers/resources
- saved workflows
- saved workflow scripts as static artifacts

Runtime workflow topology, phase/agent views, and cost rollups are later phases after runtime artifacts are discovered.

---

## Phase 8: Migration And Backfill

**Files:**
- Create `src/ingest/backfill-content-blocks.ts`
- Add CLI/stage wiring.

- [ ] **Step 1: Backfill existing skills and artifacts**

Process known skill roots and project planning docs.

- [ ] **Step 2: Backfill Claude workflow scripts**

Process `.claude/workflows` and `~/.claude/workflows` if present.

- [ ] **Step 3: Idempotence**

Backfill must be safe to rerun. `parse_fingerprint`, `blockset_hash`, and block-level hashes control whether blocks are rewritten.

---

## Phase 9: Turn Blocks For Provider Transcripts

This is not part of the MVP. Start it after artifact blocks are stable, using the same parser registry and fixture corpus.

**Future files:**
- Modify all transcript adapters.
- Add `src/ingest/content-blocks/provider-turns.test.ts`

- [ ] **Step 1: Provider-native first**

For each provider:

- Claude: preserve provider content blocks (`text`, `tool_use`, `tool_result`) and classify `role=user` tool results as `message_kind=tool_result`.
- Codex: map `function_call`, `function_call_output`, developer/system context, user tasks, assistant messages.
- Pi: map assistant tool calls and tool results.
- OpenCode/Cursor: parse current text/SQLite messages conservatively; mark tool calls only when provider data proves it.

- [ ] **Step 2: Text fallback**

Run block parser on `turn.text` for:

- XML wrappers
- headings
- file refs
- URL refs
- code fences
- command refs
- diagnostic lines
- quoted content

- [ ] **Step 3: Preserve roles**

Do not invent `tool_call` blocks in human user turns. Tool calls belong to assistant/tool-call events or separate tool result turns.

---

## Phase 10: Symbol Grounding

MVP extracts unresolved `symbol_ref` atoms only. This phase resolves those atoms against an AST-backed code index.

**Future files:**
- Create `src/ingest/symbol-index.ts`
- Create `src/ingest/symbol-index.test.ts`
- Extend atom relation writers.

- [ ] **Step 1: Build file/symbol index**

Use TypeScript AST or tree-sitter-like extraction where available:

- imports
- exports
- functions
- classes
- constants
- service names
- route names

- [ ] **Step 2: Resolve symbol atoms**

Resolve `symbol_ref` atoms to canonical `symbol` and `file` records using:

- nearby `file_ref`
- import context
- exact symbol name
- repo/workspace scope

- [ ] **Step 3: Write edges**

Add relations:

- `content_atom -> symbol`
- `content_atom -> file`
- `content_block -> file`
- future runtime agent records -> file/symbol through their blocks/atoms

---

## Phase 11: Claude Workflow Runtime Schema And Ingestion

Start this phase only after Phase 6 captures real local runtime artifacts and the generic `content_document/block/atom` representation proves insufficient for the required queries.

Expected work:

- Add runtime tables or generic runtime document mappings based on observed storage.
- Persist run, phase, agent, lifecycle, prompt, tool, result, and resume/cache facts.
- Link spawned workflow agents to `agent_session` / `agent_event` where possible.
- Preserve raw runtime artifacts for audit/debug.
- Keep ingestion behind `experimental` until real fixture tests pass.

Do not make `token_total` authoritative. Any runtime cost model must preserve input, output, cache creation, cache read, model, pricing source, and pricing effective date.

---

## Phase 12: Workflow Cost And Model Rollups

Start this after workflow runtime ingestion can link runs/phases/agents to real token usage or provider-level usage facts.

Expected work:

- Add `workflow_token_usage` only if existing `session_token_usage` cannot express the rollup.
- Preserve cache and non-cache token dimensions.
- Link workflow phase/agent rollups to `agent_model`.
- Add tests for unknown model fallback, mixed providers, cache reads/writes, and historical pricing revisions.
- Add queries for “which phase/agent cost the most?” and “what files did expensive agents inspect or edit?”

---

## Phase 13: Dashboard And UX Integration

Start this after the query layer has fixture-backed results.

Expected work:

- Artifact explorer.
- Block search UI.
- Skill trigger/resource view.
- Saved workflow script view.
- Later: workflow runtime topology view with phase/agent details and cost summaries.

---

## MVP Acceptance Criteria

- `bun test` passes for new parser/persistence modules.
- Parser registry has fixture-backed golden tests for accepted and rejected examples.
- Adding a new document style requires a fixture, a golden output, and a parser/classifier module; no dashboard regex changes are needed.
- Rejected parser attempts are observable in tests and optionally persisted as diagnostics with rejection reasons.
- Schema applies cleanly on SurrealDB 3.
- Existing transcript ingestion is not modified by the MVP.
- New ingestion writes `content_document`, `content_block`, and `content_atom` for skills, GSD docs, verification docs, state/config docs, and saved Claude workflow scripts.
- Claude workflow script ingestion detects project and personal workflow command names.
- Discovery dry-run reports considered/accepted/rejected/skipped files and bytes.
- Runtime workflow ingestion is not enabled.
- Queries can answer:
  - “List active plans/checklists.”
  - “Which skills mention Playwright?”
  - “Which saved workflow scripts exist?”
  - “Which artifacts reference this file?”
  - “Which checklist items are still open?”

Each query has a fixture DB seed and exact expected result IDs.

## Later-Phase Acceptance Criteria

These are required before the whole roadmap is complete, but not before the MVP ships:

- Runtime ingestion supports real Claude workflow run fixtures with phases, agents, tokens, elapsed time, and lifecycle state.
- Workflow cost rollups preserve input/output/cache/model/pricing-source dimensions.
- Turn block parsing covers provider-native turns for Claude/Codex/Pi/OpenCode/Cursor.
- AST-backed symbol grounding resolves `symbol_ref` atoms to canonical code definitions.
- Dashboard workflow views show phase/agent topology.
- Queries can answer:
  - “Which workflow phase used the most tokens?”
  - “Which sessions or workflow agents referenced this file/symbol?”
  - “What did the agent plan vs actually change?”

## Risks And Open Questions

- **Claude runtime storage path is not confirmed.** Do not hard-code until real Claude Code workflow run artifacts are sampled.
- **Parser complexity can sprawl.** Keep first parser conservative and provenance-heavy; raw text remains available.
- **Golden tests can become brittle.** Normalize output before comparison and keep exact offset assertions in focused unit tests only.
- **Open-source fixtures may leak private content.** Provide a redaction helper and require fixtures to avoid secrets, private repo names, and customer data.
- **Schema size is growing.** Prefer generic `content_*` records over one table per artifact type unless query shape demands specialization.
- **FTS performance needs another benchmark.** Re-run full-turn vs block BM25 benchmark once blocks exist.
- **Saved workflow JS AST may vary.** Static workflow script parsing should be best-effort; runtime records are the authoritative execution source when available.
