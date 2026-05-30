# Repository, File, And Change Knowledge Graph Design Notes

Date: 2026-05-09
Status: review draft

This note captures the current design direction before implementation planning.
It is intended for review by other agents and humans. It is not yet an
implementation plan.

## Review Summary

The core design is simple:

1. **Repository and Checkout become first-class.**
   A Repository is the stable Git identity. A Checkout is a local clone or
   worktree path. Sessions, commits, and edit evidence should link to these
   records instead of relying on path-string scans.

2. **File becomes the shared join point.**
   Agent edits, git commits, code IR, imports, and memory all point to the same
   canonical File record. File identity is repository-relative when Git is
   available.

3. **Edges carry event-specific evidence.**
   Nodes store durable identity. Edges store relationship details such as edit
   tool, path seen, checkout, diff status, additions, deletions, import
   specifier, and analyzer metadata.

4. **Change Sets and File Memory capture durable agent work memory.**
   A Change Set is the unit of work. File Memory is the per-file retrieval card
   inside that work. Commits are the preferred durable signal; session-only
   memories are provisional until they connect to commits.

5. **Tracer Context is activity-first.**
   Code IR/import context should be extracted around touched, edited, or queried
   Files first. Do not start with a full-repo static-analysis daemon.

Everything else in this document is detail for reviewers: candidate fields,
query examples, integration-test expectations, and open implementation choices.

## Problem

`ax` already ingests sessions, turns, skills, commits, edited files, and
commit-touched files. The current file identity model is too path-shaped:

- Claude/Codex tool edits can store machine-specific absolute paths.
- Git ingest stores commit-touched files as repository-relative paths, but the
  repository identity is currently an absolute checkout path.
- Worktrees, cloned repositories on another machine, and alternate project roots can
  fragment one logical file into multiple `file` records.

This weakens graph traversal and long-term memory. The tool should preserve a
stable Repository/File/change graph that can answer why a file changed, what
sessions and skills were involved, and what prior fixes are relevant.

## Current Baseline

Existing core tables include:

- `skill`
- `session`
- `turn`
- `file`
- `commit`

Existing relations include:

- `turn -> invoked -> skill`
- `turn -> edited -> file`
- `session -> produced -> commit`
- `commit -> touched -> file`
- `turn -> corrected_by -> turn`
- `turn -> proposed -> skill`
- `skill -> skill_paired -> skill`
- `turn -> recovered_by -> skill`

`touched` currently means a git commit changed a file. It carries diff stats:

- `additions`
- `deletions`

`edited` and `touched` are intentionally different signals:

- `edited`: an agent tool call edited or wrote a file during a turn.
- `touched`: a git commit later included that file in its diff.

The target design should keep both, but make them converge on the same stable
logical `file` record.

`produced` should remain the direct session-to-commit outcome relation because
existing taste scoring uses it as "this session led to a commit." Change Set
relations should be added alongside it for memory and grouping:

- `session -> worked_on -> changeset`
- `changeset -> resulted_in -> commit`

## Design Goals

1. Make repositories first-class graph records.
2. Make files stable logical records, not machine-path records.
3. Use `record<...>` fields and relation tables wherever traversal matters.
4. Preserve commit messages and touched files as durable evidence.
5. Add searchable File Memory for "why was this edited?" questions.
6. Include example SurrealQL queries and integration tests with every new graph
   shape.
7. Include a Composto-style tracer layer in the plan, not as vague future work.

Schema naming rule: use single words when they stay readable, and use
snake_case when clarity wins. Accepted examples include `changeset`,
`file_memory`, `code_ir`, `has_checkout`, and `has_ir`.

## Repository Model

Add a `repository` table for stable logical repositories.

Candidate fields:

- `key`: canonical identity, preferably normalized git remote such as
  `github.com/Necmttn/ax`
- `name`: human-readable repo basename
- `remote_url`: raw origin URL when available
- `provider`: `github`, `gitlab`, `local`, etc. where parseable
- `owner`: remote owner/org where parseable
- `remote_name`: remote repo name where parseable
- `first_seen_at`
- `last_seen_at`

Add a `checkout` table for machine/worktree-specific paths.

Candidate fields:

- `repository`: `record<repository>`
- `root_path`: absolute checkout root path on the current machine
- `cwd_seen`: session cwd that led to this checkout
- `branch`: best-effort current branch
- `head`: best-effort current commit
- `first_seen_at`
- `last_seen_at`

Candidate relation:

- `repository -> has_checkout -> checkout`

Checkout should be a normal node table, not just an edge with fields. Sessions,
edits, diagnostics, and derivation may all need to refer to a Checkout directly.
The `has_checkout` edge can stay simple. This separates stable Repository
Identity from local checkout aliases.

## File Model

Change `file.repository` to a `record<repository>` where possible.

Target file shape:

- `repository`: `option<record<repository>>`
- `path`: repository-root-relative path when `repository` is known
- `lang`: optional language tag
- optional future display/path metadata only when useful

For non-git files, keep:

- `repository = NONE`
- `path = absolute path`

Non-git workspace roots can be modeled later with a `workspace` table if needed.

File record IDs should be derived from stable Repository Identity plus relative
path, not from absolute checkout roots.

## Commit Model

Change `commit.repository` to `record<repository>` where possible.

Keep existing durable fields:

- `sha`
- `message`
- `author`
- `ts`

Add observed ingest context:

- `checkout`: `option<record<checkout>>`

Commit messages are important evidence for later BM25 and semantic search.

## Session Model

Add direct optional graph links:

- `session.repository`: `option<record<repository>>`
- `session.checkout`: `option<record<checkout>>`

Keep existing observed metadata:

- `session.cwd`
- `session.project`

This avoids path scans for common queries while preserving the raw session data
that came from Claude/Codex transcripts.

## RecordId And Traversal Rules

Prefer RecordIds and graph edges where possible:

- `file.repository = repository:<id>`, not `"/Users/.../repo"`
- `commit.repository = repository:<id>`, not `"/Users/.../repo"`
- `checkout.repository = repository:<id>`
- `session.repository = repository:<id>`
- `session.checkout = checkout:<id>`
- `commit.repository = repository:<id>`
- `commit.checkout = checkout:<id>` when the ingesting Checkout is known
- relation tables for traversal:
  - `turn -> edited -> file`
  - `commit -> touched -> file`
  - `session -> produced -> commit`
  - `repository -> has_checkout -> checkout`

`edited` should keep the canonical File as its `out`, while storing observed
machine-specific evidence on the edge:

- `checkout`: `option<record<checkout>>`
- `path_seen`: original path from the tool payload
- `absolute_path_seen`: absolute path when known
- `tool`
- `ts`

`touched` should keep the canonical File as its `out`, while storing commit diff
evidence on the edge:

- `status`: `added | modified | deleted | renamed | copied | unknown`
- `old_path`: option<string>
- `new_path`: option<string>
- `checkout`: `option<record<checkout>>`
- `additions`
- `deletions`
- `ts`

For renames, `out` should usually be the post-change File and the old/new paths
should be preserved on the edge. For deletions, `out` should be the deleted File.

String fields are display/search metadata. RecordIds and relation tables are
the source of truth for graph traversal.

Avoid making `cwd starts_with repo_path` the main join strategy. It can remain a
fallback during migration/discovery, but should not be the durable graph model.

## Change Knowledge

Add a searchable change knowledge layer for both file-first and work-first
agent workflows.

Canonical terms:

- **Change Set**: a coherent unit of work that may touch multiple Files and
  can be recalled as a pattern for future work.
- **File Memory**: a searchable per-File explanation or evidence packet within
  a Change Set.

Candidate table: `changeset`

Candidate fields:

- `repository`: `record<repository>`
- `commit`: `option<record<commit>>`
- `session`: `option<record<session>>`
- `ts`
- `source`: `session | commit | derived`
- `title`: short unit-of-work label
- `summary_text`: searchable work-level summary

Candidate table: `file_memory`

Candidate fields:

- `repository`: `record<repository>`
- `file`: `record<file>`
- `changeset`: `record<changeset>`
- `commit`: `option<record<commit>>`
- `session`: `option<record<session>>`
- `turn`: `option<record<turn>>`
- `ts`
- `source`: `commit | edit_turn | derived`
- `confidence`: `observed | derived`
- `status`: `current | superseded`
- `superseded_by`: `option<record<file_memory>>`
- `generation`: int
- `title`: short file-specific intent
- `text`: searchable file-specific corpus
- `additions`: optional copy from `touched`
- `deletions`: optional copy from `touched`
- `skills`: optional list or future relation

`text` should combine durable observable evidence, not hidden model reasoning:

- commit message
- file path
- nearby user request
- nearby assistant explanation or plan excerpt
- edit/tool evidence
- diff stats
- session/project metadata

`File Memory` should stay a compact retrieval card. Link but do not copy full
transcripts, raw source, full diffs, full tool args, or full command output by
default.

Generation should be deterministic first. A reproducible baseline can combine
commit message, file path, nearest user intent excerpt, tool/action summary,
diff stats, and related skills/tools. LLM-generated summaries can be optional
enrichment later, with their own model/confidence metadata.

Superseded `file_memory` records should be preserved for auditability rather
than overwritten. Default retrieval should filter to current records.

`Change Set` source precedence:

1. Start with session-based Change Sets while work is uncommitted.
2. Start with commit-based Change Sets when ingesting git history.
3. Prefer derived Change Sets when session activity and commit evidence overlap
   by time and Files.

Uniqueness rule:

- one commit should produce at most one commit-sourced `changeset`
- one session should produce at most one provisional session-sourced `changeset`
  by default
- a derived `changeset` can supersede or link the session/commit-sourced
  records once evidence connects them

Superseded `changeset` records should be preserved for auditability rather than
deleted. Query defaults can filter to current records, while debugging and
review tools can inspect superseded derivation history.

Candidate fields:

- `status`: `current | superseded`
- `superseded_by`: `option<record<changeset>>`

Commit evidence should be treated as the preferred durable outcome signal. Most
useful `ax` memory should connect to commits, and session-only Change Sets
should be marked provisional until a matching commit appears. The tool should
make this visible to users and encourage commit practices that preserve useful
signals.

Commit Signal coaching should be diagnostic, not blocking. `ax project
verify` and future memory commands can surface weak signals such as vague commit
messages, edited files without nearby commits, huge mixed commits, or commits
that do not match nearby agent session files.

Minimum evidence for a derived Change Set:

- one Session
- one Commit
- at least one overlapping File between session edits and commit-touched Files
- temporal overlap, where the commit falls within the session window or within
  a configurable grace period after session end

Default grace period: 24 hours.

Add BM25 indexes over `changeset.summary_text` and `file_memory.text`, and
likely over commit messages and file paths where useful.

## Claude Insights Artifacts

Claude `/insights` writes a local report under `~/.claude/usage-data/`. The
HTML report is presentation. The reusable artifacts are the JSON files:

- `session-meta/*.json`: deterministic session telemetry such as project path,
  start time, duration, message counts, tool counts, token counts, tool errors,
  first prompt, git commits, git pushes, lines changed, files modified, language
  counts, MCP/web usage, and user interruption/response timing.
- `facets/*.json`: model-derived session labels such as underlying goal, goal
  categories, outcome, satisfaction counts, helpfulness, session type, friction
  counts/detail, primary success, and brief summary.

Treat these as a useful analyzer source, not as canonical state. The metadata
can backfill or validate `session` telemetry. The facets should become
`Session Insight` enrichment linked to `session`, and can seed Change Set titles
or summaries when no stronger derived evidence exists.

Candidate table: `session_insight`

Candidate fields:

- `session`: `record<session>`
- `source`: `claude_insights`
- `source_path`: path to the source JSON artifact
- `underlying_goal`
- `goal_categories`: JSON string
- `outcome`
- `user_satisfaction_counts`: JSON string
- `claude_helpfulness`
- `session_type`
- `friction_counts`: JSON string
- `friction_detail`
- `primary_success`
- `brief_summary`
- `created_at`

Useful queries this unlocks:

- "Show sessions where Claude marked `wrong_approach` or `buggy_code` and the
  files/commits involved."
- "Find mostly successful integration work and inspect the Files that moved
  together."
- "Compare ax-derived Change Sets with Claude's `underlying_goal` and
  `brief_summary` to validate the derivation quality."
- "Rank repositories by friction, tool errors, and weak Commit Signal."

## Evidence And Insight Tables

The schema should separate observed evidence from derived interpretation.

Evidence/event layer:

- `tool`
- `tool_call`
- `plan`
- `plan_item`
- `plan_snapshot`
- `diagnostic_event`
- `friction_event`
- `turn_analysis`
- `semantic_signal`
- `artifact`
- `guidance`
- `guidance_version`

Derived memory/product layer:

- `changeset`
- `file_memory`
- `insight`
- `recommendation`

This split keeps auditability clear. A tool failure, user correction, lint
error, or plan update happened at a specific time. An insight or recommendation
is an interpretation over those events.

## Tool And Command Evidence

Add first-class tool records and tool-call evidence.

Candidate table: `tool`

Candidate fields:

- `name`
- `kind`: `builtin | cli | mcp | skill | slash_command | api | unknown`
- `provider`: `claude | codex | local | mcp:<server> | unknown`
- `description`
- `first_seen_at`
- `last_seen_at`

Candidate table: `tool_call`

Candidate fields:

- `session`: `record<session>`
- `turn`: `record<turn>`
- `tool`: `record<tool>`
- `seq`
- `ts`
- `cwd`: `option<string>`
- `repository`: `option<record<repository>>`
- `checkout`: `option<record<checkout>>`
- `args`: JSON string
- `command_text`: option<string>
- `command_norm`: option<string>
- `command_tool`: option<record<tool>>
- `output_excerpt`: option<string>
- `error_text`: option<string>
- `exit_code`: option<int>
- `duration_ms`: option<int>
- `has_error`: bool

For Bash and shell-like calls, store both layers:

- `tool = Bash`
- `command_tool = git | gh | bun | surreal | ...` when command extraction is
  reliable
- `command_norm = "git status"`, `"bun test"`, `"surreal sql"`, etc.

Canonical edit and skill evidence should move to tool-call level:

- `tool_call -> edited -> file`
- `tool_call -> invoked -> skill`

`turn -> edited -> file` and `turn -> invoked -> skill` can remain temporary
compatibility edges or derived rollups for existing taste queries.

## Plans

Plans are durable reasoning evidence. They often preserve task boundaries,
grounding file references, risk reasoning, verification intent, and deferred
work that never appears in commits.

Claude evidence:

- `TodoWrite` emits structured snapshots with `todos[]` containing
  `content`, `activeForm`, and `status`.
- `TaskCreate` emits task creation with `subject`, `description`, and
  `activeForm`.
- `TaskUpdate` emits status transitions by task id.

Codex evidence:

- `update_plan` emits structured snapshots with `plan[]` containing `step` and
  `status`, plus an `explanation` string.

Candidate table: `plan`

Candidate fields:

- `session`: `record<session>`
- `source`: `claude_todowrite | claude_task | codex_update_plan | inferred`
- `status`: `active | completed | abandoned | superseded`
- `created_at`
- `updated_at`
- `raw_artifact`: `option<record<artifact>>`

Candidate table: `plan_item`

Candidate fields:

- `plan`: `record<plan>`
- `external_id`: option<string>
- `seq`
- `content`
- `active_form`: option<string>
- `status`: `pending | in_progress | completed | abandoned`
- `first_seen_at`
- `last_seen_at`

Candidate table: `plan_snapshot`

Candidate fields:

- `plan`: `record<plan>`
- `tool_call`: `record<tool_call>`
- `items_json`: JSON string
- `explanation`: option<string>
- `ts`

Create file/tool links lazily:

- `plan_item -> concerns -> file`
- `plan_item -> concerns -> tool`

The `concerns` edge should carry `source`, `ref_text`, `confidence`, `weight`,
and `ts`. Exact path references can be resolved deterministically; fuzzy
references should wait for derivation/search context.

## Friction, Feedback, And Diagnostics

Friction should be first-class evidence, not only counters inside imported
insights.

Candidate table: `friction_event`

Candidate fields:

- `session`: `record<session>`
- `turn`: `option<record<turn>>`
- `tool_call`: `option<record<tool_call>>`
- `repository`: `option<record<repository>>`
- `checkout`: `option<record<checkout>>`
- `changeset`: `option<record<changeset>>`
- `target_type`: `file | tool | skill | mcp | command | checkout | repository | guidance | external | unknown`
- `target_file`: `option<record<file>>`
- `target_tool`: `option<record<tool>>`
- `target_skill`: `option<record<skill>>`
- `target_name`: `option<string>`
- `kind`: controlled normalized taxonomy
- `raw_kind`: option<string>
- `severity`: `low | medium | high`
- `source`: `detector | llm | imported`
- `confidence`: `observed | inferred`
- `evidence_text`: option<string>
- `detector`: option<string>
- `ts`
- `raw`: JSON string

Recommended normalized friction kinds:

- `retry`
- `tool_error`
- `failed_edit`
- `repeated_edit`
- `user_correction`
- `plan_revision`
- `wrong_approach`
- `misunderstood_request`
- `buggy_code`
- `excessive_changes`
- `runtime_limit`
- `environment_blocker`
- `external_blocker`
- `unresolved_work`
- `abandoned_edit`
- `unknown`

Candidate tables: `turn_analysis`, `semantic_signal`, and `reacts_to`

Candidate fields:

- `session`
- `turn`
- `kind`: `correction | approval | rejection | preference | strategy | satisfaction | question | unknown`
- `sentiment`: `positive | neutral | negative | mixed | unknown`
- `target_type`: `file | tool | skill | recommendation | changeset | schema | agent_behavior | unknown`
- typed optional targets
- `evidence_text`
- `source`: `detector | llm | imported`
- `confidence`
- `ts`

Candidate table: `diagnostic_event`

Candidate fields:

- `session`
- `turn`: option<record<turn>>
- `tool_call`: option<record<tool_call>>
- `repository`: option<record<repository>>
- `checkout`: option<record<checkout>>
- `file`: option<record<file>>
- `tool`: option<record<tool>>
- `kind`: `lint | typecheck | test | build | runtime | db | ci | unknown`
- `severity`: `info | warning | error`
- `message_excerpt`
- `line`: option<int>
- `column`: option<int>
- `command_norm`
- `source`
- `ts`

Diagnostics are technical findings. Friction is workflow pain. A failing test is
not automatically friction during intentional TDD; it becomes friction when it
is repeated, unresolved, unexpected, or corrected by the user.

## Artifacts

Use `artifact` for raw or bulky evidence that is not a canonical repository
File.

Candidate table: `artifact`

Candidate fields:

- `kind`: `transcript | report | screenshot | log | json | html | diff | patch | trace | tool_output | plan | other`
- `source`: `claude | codex | ax | browser | cli | imported`
- `uri`
- `content_hash`: option<string>
- `bytes`: option<int>
- `mime`: option<string>
- `created_at`

Relations:

- `session -> has_artifact -> artifact`
- `tool_call -> produced_artifact -> artifact`
- `insight -> derived_from -> artifact`
- `diagnostic_event -> derived_from -> artifact`
- `plan_snapshot -> derived_from -> artifact`

Store compact summaries in hot rows and raw large payloads as artifacts.

## Recommendations And Guidance

Recommendations should be persisted because they have lifecycle.

Candidate table: `recommendation`

Candidate fields:

- `kind`: `skill | rule | workflow | tool | hook | commit_practice | environment | integration`
- `scope`: `global | repository | checkout | workspace`
- `repository`: option<record<repository>>
- `checkout`: option<record<checkout>>
- `workspace`: option<record<workspace>>
- `title`
- `rationale`
- `status`: `open | applied | dismissed | stale`
- `source`: `detector | llm | imported`
- `confidence`: `observed | inferred`
- `created_at`
- `updated_at`

Guidance should be versioned so ax can measure before/after behavior for
CLAUDE.md, AGENTS.md, hooks, settings, skills, and Codex instructions.

Candidate table: `guidance`

Candidate fields:

- `kind`: `claude_md | agents_md | hook | settings | skill | codex_instruction | command | other`
- `scope`: `global | repository | checkout | workspace`
- `repository`: option<record<repository>>
- `checkout`: option<record<checkout>>
- `path`: option<string>
- `title`
- `enabled`: bool
- `current_version`: option<record<guidance_version>>

Candidate table: `guidance_version`

Candidate fields:

- `guidance`: record<guidance>
- `content_hash`
- `text_excerpt`
- `git_commit`: option<record<commit>>
- `observed_at`
- `valid_from`
- `valid_to`: option<datetime>
- `source`: `git_commit | file_scan | imported | manual`

Use Git commits as preferred version boundaries when available. Use filesystem
observation time for global config, uncommitted local guidance, or hooks that
are active before being committed.

This enables behavior metrics such as:

- root edits before and after a worktree guard hook
- user corrections before and after a CLAUDE.md rule
- tool failures before and after a settings change
- blocked/warned/bypassed hook behavior once hook outputs are ingested

## Generic Aboutness

Use a generic `concerns` relation for broad evidence targeting:

```sql
DEFINE TABLE concerns TYPE RELATION
  FROM plan_item | friction_event | recommendation | insight | diagnostic_event
  TO file | tool | skill | repository | checkout | changeset | session | artifact | guidance | guidance_version;
```

Candidate edge fields:

- `source`: `exact_path | fuzzy_ref | detector | llm | imported | user`
- `ref_text`: option<string>
- `confidence`: `observed | inferred`
- `weight`: option<float>
- `ts`

Use specific edges for stronger lifecycle/result semantics:

- `tool_call -> edited -> file`
- `commit -> touched -> file`
- `changeset -> involves -> file`
- `changeset -> includes -> file_memory`
- `session -> produced -> commit`
- `plan -> resulted_in -> changeset`
- `recommendation -> suggests -> skill`
- `new -> supersedes -> old`

## Insights Surface

The graph should ship with a visible dashboard/app surface, not only CLI queries.
This is important for adoption: users should see the value of the local graph in
the first minute, before they learn SurrealQL or ask an agent to query it.

The surface should feel like an engineering memory cockpit:

- **Today / recent work**: active sessions, commits, touched Files, current
  Change Sets, and unfinished provisional work.
- **Repository health**: Commit Signal, worktree discipline, tool failures,
  test/build failure clusters, and stale provisional Change Sets.
- **What changed together**: file co-change maps from `changeset -> involves ->
  file`, useful for future implementation planning.
- **Why this file changed**: File Memory timeline with commit messages, user
  intent, tool evidence, and related sessions.
- **Where agents struggle**: friction clusters such as wrong approach, buggy
  code, repeated edits, misunderstood request, tool timeout, and environment
  blocker.
- **Recommendations**: evidence-backed suggestions for skills, CLAUDE.md /
  AGENTS.md rules, MCP integrations, commit hygiene, and workflow changes.
- **Agent/tool usage**: skill usage, MCP usage, tool mix, subagent/delegation
  patterns, and which workflows produce good outcomes.

The UI should not be a static report clone. It should be backed by the same
query adapter used by the CLI, so the dashboard, integration tests, and agent
query interface exercise the same SurrealDB queries.

First useful product views:

1. Repository overview
2. Session detail
3. Change Set detail
4. File Memory timeline
5. Friction/recommendation board

Design direction: dense, operational, and high-signal. The first viewport should
show real local evidence: recent repositories, live counts, most edited files,
top friction clusters, and one surprising recommendation with linked evidence.
Avoid a marketing landing page; the app itself is the first screen.

## Derivation Engine Boundary

`ax` should own the Derivation Engine: the agent-neutral logic that turns
normalized sessions, edits, commits, and touched files into Change Sets and File
Memories.

Codex-specific Rust code from `codex-rs` can be useful as an adapter, reference,
or helper for parsing Codex traces. It should not define the durable `ax`
domain model.

Target boundary:

```text
Derivation Engine
  input: normalized sessions, turns, edits, commits, touched files
  output: Change Sets + File Memories

Codex Adapter
  input: Codex traces/sessions/rollouts
  output: normalized ax session/turn/tool events
```

## Storage Backend Boundary

The storage backend should not shape product semantics. RocksDB should remain
the default backend. SurrealKV, including `surrealkv+versioned`, can be explored
as a configurable experimental backend, but backend versioning must not be
required by user-facing queries, integration tests, File Memory history, or
Change Set supersession.

Model history explicitly in the graph instead:

- `changeset.status`
- `changeset.superseded_by`
- `file_memory.status`
- `file_memory.superseded_by`
- generation / created-at metadata where needed

This keeps agent queries normal and portable across storage engines.

## Current Views

Use SurrealDB materialized table views as tested read surfaces, not canonical
truth. The canonical supersession model remains:

- `new changeset -> supersedes -> old changeset`
- `new file_memory -> supersedes -> old file_memory`
- stored `status` / `superseded_by` fields maintained by the Derivation Engine

Do not expose `status = "current"` filtering throughout application code. Query
through an adapter that can target a Current View or fall back to the base table
plus a status predicate.

Candidate views:

```sql
DEFINE TABLE current_file_memory AS
SELECT *
FROM file_memory
WHERE status = "current";

DEFINE TABLE current_changeset AS
SELECT *
FROM changeset
WHERE status = "current";
```

Before relying on these views, run a spike/integration test against the pinned
SurrealDB version:

- create current row -> appears in view
- update to superseded -> disappears from view
- full-text search on the view or source table behaves as expected
- RecordId fields survive projection
- relation traversals from projected rows behave as expected
- source-table indexes exist for `status` and other view predicates
- import/backfill workflows rebuild or validate the view explicitly

Avoid putting linked-record denormalized metadata in the view unless source-table
writes also refresh it. SurrealDB view updates are triggered by the table in the
`FROM` clause, not by arbitrary linked records used in projections.

## Composto-Style Tracer Layer

This should be part of the plan as a real milestone.

The useful ideas from Composto are:

- layered code representations
- token-efficient IR
- health annotations
- context packing within a budget
- tracing from a target file/symbol into relevant neighbors

`ax` should persist the durable graph. Composto-style IR should be a
derived/enrichment layer on top of the Repository/File/change graph.

Tracer Context should be activity-first and lazy. Generate IR/import context for
Files touched by commits, edited by agents, or explicitly queried first. Import
neighbors can be expanded on demand during trace commands. Avoid an eager
full-repo static-analysis daemon in the initial implementation.

Candidate tables:

- `code_ir`
- `code_finding`
- `symbol`

Candidate relations:

- `file -> has_ir -> code_ir`
- `file -> imports -> file`
- `file -> defines -> symbol`
- `symbol -> calls -> symbol` eventually
- `changeset -> includes -> file_memory`
- `changeset -> involves -> file`
- `file_memory -> concerns -> file`
- `file_memory -> mentions_symbol -> symbol` eventually

Candidate `code_ir` fields:

- `repository`: `record<repository>`
- `file`: `record<file>`
- `commit`: optional `record<commit>` or checkout head identity
- `layer`: `L0 | L1 | L2 | L3`
- `engine`: `ax | composto | fallow | other`
- `text`: compressed representation, except raw source should normally remain a
  pointer rather than duplicated full text
- `raw_tokens`
- `ir_tokens`
- `generated_at`

Layer meanings:

- `L0`: file identity plus declarations/structure map
- `L1`: compressed semantic IR
- `L2`: diff-aware/change context
- `L3`: raw source pointer or exact source when explicitly needed

Future CLI direction:

```bash
ax trace file src/ingest/git.ts --budget=4000
ax trace query "why does repository detection duplicate worktrees?"
```

The trace output should pack target file evidence, import neighbors, recent
change context, relevant commits, and relevant prior sessions within a budget.

## Example Queries For Review And Tests

Find all logical files touched by commits produced from a session:

```sql
SELECT ->produced->commit->touched->file AS files
FROM session:<session_id>;
```

Explain why a file changed:

```sql
SELECT
  <-touched<-commit.message AS commit_messages,
  <-edited<-turn.text_excerpt AS edit_contexts
FROM file:<file_id>;
```

Find prior change knowledge by BM25:

```sql
SELECT file, commit, text
FROM file_memory
WHERE text @@ "surreal schema migration"
ORDER BY search::score(0) DESC
LIMIT 10;
```

Find prior work patterns by BM25:

```sql
SELECT title, summary_text, ->involves->file AS files
FROM changeset
WHERE summary_text @@ "new integration registry backend UI"
ORDER BY search::score(0) DESC
LIMIT 10;
```

Find all Checkouts for one logical Repository:

```sql
SELECT ->has_checkout->checkout AS checkouts
FROM repository:<repository_id>;
```

Find Files most often edited by agents in a Repository:

```sql
SELECT out AS file, count() AS edits
FROM edited
WHERE out.repository = repository:<repository_id>
GROUP BY out
ORDER BY edits DESC
LIMIT 20;
```

Find commits connected to a skill through sessions:

```sql
SELECT
  out AS commit,
  out.message AS message
FROM produced
WHERE in IN (
  SELECT VALUE in.session
  FROM invoked
  WHERE out = skill:<skill_id>
)
ORDER BY out.ts DESC
LIMIT 20;
```

Trace from a file to dependencies and prior reasoning:

```sql
SELECT
  ->imports->file AS dependencies,
  <-touched<-commit AS commits,
  <-edited<-turn AS edit_turns
FROM file:<file_id>;
```

Find prior fixes touching import neighbors:

```sql
SELECT *
FROM file_memory
WHERE file IN (
  SELECT VALUE ->imports->file FROM file:<file_id>
)
AND text @@ "fix";
```

Build packed context inputs for a target file:

```sql
SELECT
  path,
  <-has_ir<-code_ir[layer = "L1"] AS ir,
  <-touched<-commit.message AS recent_commits,
  <-edited<-turn.text_excerpt AS recent_agent_context
FROM file:<file_id>;
```

## Integration Test Expectations

Use seeded DB fixtures, not only unit tests.

Minimum scenarios:

- The same file edited through two different worktree paths resolves to one
  logical `file` record.
- `git touched` and transcript `edited` point to the same `file` record.
- One stable `repository` has multiple `checkout` aliases.
- `commit.message` is searchable through `file_memory`.
- Multi-file work is represented by one `changeset` with multiple
  `file_memory` records.
- `session -> produced -> commit -> touched -> file` traversal works.
- `skill -> invocation session -> produced commit` traversal works.
- `file -> imports -> file` traversal works for a tiny TypeScript fixture.
- Trace query includes IR, prior reasoning, touched files, and edit context.

## Implementation Sequencing To Consider Later

Candidate milestones:

1. Add first-class `repository` and `checkout`.
2. Normalize file identity and migrate ingest paths to repository-relative files.
3. Convert commit/file repository fields to RecordIds and update graph traversals.
4. Add `changeset`, `file_memory`, and BM25 search.
5. Add example queries as integration tests.
6. Add Composto-style tracer tables and file-level dependency ingestion.
7. Add trace/context packing CLI.

## Open Questions

- Should `repository` IDs be based on normalized remote URL, a hash of remote URL, or a
  human-readable owner/name slug with collision handling?
- How should local-only Repositories without remotes be identified across machines?
- Should `checkout` be a normal table linked by `has_checkout`, or should
  checkout paths be modeled as direct relation edges with fields?
- How aggressively should derived Change Sets merge session activity and commit
  evidence?
- Which subset of raw transcript context should be copied into searchable
  File Memory text versus kept only in raw transcript buckets?
- Should Composto be an optional adapter, an inspiration for native IR, or both?
