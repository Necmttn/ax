# Repository Evidence Graph Queries

`src/queries/insights.ts` is the shared adapter for dashboard-grade evidence
graph queries. CLI, TUI, and integration tests should reuse these builders
instead of embedding ad hoc SurrealQL that can drift from the schema.

Example commands:

```bash
axctl insights
axctl insights schema
axctl insights repositories --limit=25
axctl insights checkouts --limit=25
axctl insights git --limit=25
axctl insights friction --limit=50
axctl insights tools --limit=20
axctl insights sessions --limit=20
axctl insights feedback-loops --limit=20
axctl insights verification-gaps --limit=20
axctl insights user-language --limit=20
axctl insights token-impact --limit=20
axctl insights cache-health --limit=20
axctl insights workflow-impact --limit=20
axctl insights codex-health --limit=20
axctl insights closure --limit=20
axctl insights post-feature-fixes --limit=20
axctl insights skill-candidates --limit=20
axctl insights graph-health --limit=10
axctl dashboard --limit=25
```

The builders target the current schema fields directly:

- `repositoryOverviewSql` reads `repository` and counts
  `->has_checkout->checkout`.
- `checkoutActivitySql` reads `checkout` and counts linked sessions, turns,
  tool calls, failures, produced commits, and touched files per worktree or
  local checkout.
- `gitCorrelationSql` reads repository-linked sessions, commits, `produced`,
  and `touched` evidence so a dashboard can show whether transcript activity
  is attached to Git history.
- `recentFrictionSql` reads `friction_event` and returns the JSON-encoded
  `labels`, `metrics`, and `raw` fields rather than flattened draft fields.
- `toolFailuresSql` groups `tool_call` rows with `WHERE has_error = true`.
- `sessionEvidenceSql` summarizes session-linked tool calls, failures,
  friction events, and plan snapshots.
- `feedbackLoopsSql` groups persisted `command_outcome` rows so expected test
  feedback, guardrails, search misses, and real blockers can be separated.
- `verificationGapsSql` finds sessions with edits but no verification-shaped
  command outcomes.
- `userLanguageSql` reads persisted `user_message_ngram` aggregates from user
  turns, including correction and verification proximity counters.
- `tokenImpactSql` compares actual or estimated token usage by workflow epoch
  and provider.
- `cacheHealthSql` surfaces sessions with actual cache metrics when present,
  otherwise high estimated-token sessions that need better provider metadata.
- `workflowImpactSql` compares turns, tool calls, tool errors, corrections,
  interruptions, subagent dispatches, and estimated tokens by workflow epoch.
- `codexHealthSql` ranks non-empty Codex sessions by estimated context cost.
- `closureSql` summarizes commit lifecycle classifications.
- `postFeatureFixesSql` lists feature commits followed by overlapping fix
  commits within the configured window.
- `skillCandidatesSql` lists evidence-backed skill or guardrail candidates
  derived from fix chains and risky sessions.
- `schemaCoverageSql` reports every schema table as `active`, `conditional`,
  or `staged`, so intentionally empty tables are visible instead of surprising
  in Surrealist.

## Harness Doctor Tables And Ingestion Status

The Harness Doctor slice adds schema support for these tables:

- `guidance_source`
- `guidance_revision`
- `stack`
- `agent_tooling`
- `harness_learning`
- `intervention`
- `intervention_observation`

Current implementation status:

- `axctl project harness` scans repo-local and global guidance sources at
  report time.
- `axctl project harness --json` returns Guidance Sources, Guidance
  Revisions, Stack signals, Agent Tooling signals, Harness Doctor findings, the
  first local Harness Learning candidate, an Intervention suggestion, and an
  Intervention Observation.
- `axctl project harness` also reads existing `tool_call`, `edited`, and
  `produced` graph evidence so observed tooling and main-branch write-risk
  signals are grounded in the current database.
- Default `axctl ingest` persists the Harness Doctor report into the staged
  Harness Doctor tables via the `harness/doctor` ingest stage.
- Default `axctl ingest` also persists command outcome classifications and
  user-message n-grams via the `outcomes/derive` ingest stage.
- Default `axctl ingest` persists token/cache/workflow health via the
  `session-health/derive` ingest stage.
- Default `axctl ingest` persists commit lifecycle, post-feature fix-chain,
  and skill-candidate records via the `closure/derive` ingest stage.
- Default `axctl ingest` persists gotchas, taste signals, workflows,
  learning feedback, learning matches, and draft adoptions via the
  `learning-registry/derive` ingest stage.

The harness ingest stage is idempotent and:

1. Upserts `guidance_source` rows keyed by path.
2. Upserts `guidance_revision` rows keyed by source path plus content hash.
3. Upserts declared and observed `stack` records.
4. Upserts `agent_tooling` records from package scripts, global tools, and
   observed tool calls.
5. Upserts local `harness_learning` candidates.
6. Upserts approval-gated `intervention` suggestions.
7. Upserts `intervention_observation` rows with before/after metric fields.

Use `axctl project harness --json` as the canonical report surface and
`axctl insights schema` to verify durable table population after ingest.

## Command Outcome And User Language Tables

The command outcome slice adds:

- `command_outcome`
- `user_message_ngram`

`command_outcome` is keyed from the original `tool_call` record and classifies
commands into `success`, `expected_feedback`, `search_miss`, `guardrail`,
`environment_blocker`, `workflow_error`, `product_bug_signal`, or `unknown`.
This keeps useful TDD/lint/typecheck feedback distinct from real workflow
friction.

`user_message_ngram` is derived from `turn.role = "user"` excerpts and stores
bi-gram/tri-gram frequency plus correction, failed-tool, edit, and verification
proximity counters. It is an intentionally small first pass for mining repeated
preferences, corrections, and language that should become taste or harness
learning candidates.

## Session Token And Workflow Health Tables

The session health slice adds:

- `workflow_epoch`
- `session_token_usage`
- `session_health`

`workflow_epoch` currently derives a `gsd` to `superpowers` split from the first
observed `superpowers:*` skill invocation. This is a heuristic, but it creates a
stable comparison anchor for dogfooding workflow migration questions.

`session_token_usage` uses Claude insights usage metadata when available
(`input_tokens`, `output_tokens`, cache token counters, context window) and
falls back to a transcript-byte token estimate for Claude/Codex sessions without
provider metrics.

`session_health` records turns, tool calls, tool errors, correction-like user
messages, interruption/status/redirect-like user messages, subagent dispatches,
plan snapshots, estimated tokens, cache ratios, and a coarse context-pressure
bucket. These rows power `token-impact`, `cache-health`, `workflow-impact`, and
`codex-health`.

## Closure Quality And Skill Candidate Tables

The closure-quality slice adds:

- `commit_classification`
- `later_fixed_by`
- `skill_candidate`
- `suggests_skill`

`commit_classification` classifies commit messages as `feature`, `fix`,
`refactor`, `test`, `docs`, `chore`, or `unknown`.

`later_fixed_by` links a feature commit to a later fix commit when they share a
repository, land within the time window, and touch one or more of the same
files. This is a deliberately conservative first pass: it treats same-file
post-feature fixes as evidence that closure quality could improve.

`skill_candidate` turns repeated fix-chain patterns and risky session health
signals into candidate skills or guardrails, such as ingest idempotency checks,
schema-change smoke tests, live query dogfooding, or session closure quality
gates.

## Learning Registry And Onboarding

The learning-registry slice adds:

- `gotcha`
- `taste_signal`
- `workflow`
- `learning_feedback`
- `learning_match`
- `adoption`

`learning-registry/derive` converts local skill candidates and Harness Doctor
learnings into draft-only local registry rows. Hosted sharing, public taste
cards, and auto-publishing are intentionally disabled in these seed records.

`axctl onboarding --json` checks whether global Claude, Codex, and shared
agent guidance directories are git-tracked. This gives future guidance and
skill experiments commit evidence before ax starts recommending harness
changes.

`axctl interventions list|impact|regressions|candidates --json` is the first
read surface for intervention lifecycle work: proposed interventions, measured
observations, high-risk regression sessions, and candidate skills.

SurrealKit workflow takeaway: local development can keep importing the schema
directly for now. Tests should prefer isolated databases or namespaces so
query/integration runs do not mutate the user's main `ax/main` graph.
A future schema sync and rollout workflow can be added once the evidence graph
stabilizes.

Implementation-pattern reference: `docs/effect-reference-t3code.md` captures
Effect practices from the local `.references/t3code` clone that are worth
adapting as the prototype grows, especially typed config, process services,
schema decoders, and layer-based tests.

## Prototype Verification Notes

The prototype writes the new evidence graph beside the legacy taste graph.
Existing taste/search commands continue to read legacy edges while the new
insight commands read through `src/queries/insights.ts`.

Verification commands run:

- `bun run db:schema`
- `bun src/cli/index.ts ingest --since=1`
- `bun src/cli/index.ts ingest-insights`
- `bun src/cli/index.ts insights schema --limit=5`
- `bun src/cli/index.ts insights repositories --limit=5`
- `bun src/cli/index.ts insights checkouts --limit=5`
- `bun src/cli/index.ts insights git --limit=5`
- `bun src/cli/index.ts insights friction --limit=5`
- `bun src/cli/index.ts insights tools --limit=5`
- `bun src/cli/index.ts insights sessions --limit=5`
- `bun src/cli/index.ts dashboard --limit=5`

## 2026-05-11 Dogfood Notes

Full backlog dogfood ran:

- `bun run db:schema`
- `bun src/cli/index.ts ingest-insights --progress=plain`
- `bun src/cli/index.ts ingest --since=1 --progress=plain`
- `bun test`
- `bun run typecheck`
- `bun run build`
- `bun run check:cli-reference`
- `bun src/cli/index.ts project harness --json`
- `bun src/cli/index.ts onboarding --json`
- `bun src/cli/index.ts dashboard --limit=5`
- `bun src/cli/index.ts insights <new-view> --limit=3` for feedback loops,
  user language, token/cache/workflow/Codex health, closure, post-feature
  fixes, skill candidates, and graph health.
- `bun src/cli/index.ts ingest-insights --progress=plain` now imports both
  Claude usage-data facets and legacy dotfiles self-improve artifacts from
  `~/.dotfiles/claude/.claude/self-improve/runs/*`.

Observed outputs:

- Full ingest reached every derived stage: `outcomes/derive`,
  `session-health/derive`, `closure/derive`, `learning-registry/derive`, and
  `harness/doctor`.
- Latest full ingest wrote 3,183 command outcomes, 421 user n-grams, 37 recent
  session-health rows, 1,321 commit classifications, 1,089 fix-chain edges, 5
  skill candidates, 5 gotchas/adoptions, and 25 learning matches.
- `project harness --json` found 12 guidance sources and 1 intervention
  suggestion.
- `onboarding --json` reports Claude and shared agent guidance as git-tracked;
  Codex global guidance is currently a warning because `~/.codex` is not
  tracked.
- Dashboard generation reported `tools=69,655`, `plans=244`,
  `friction=4,434`, and `sessions=3,357`.

Dogfood fixes made during the backlog run:

- `feedback-loops` now filters successful/no-command rows so expected feedback
  and blockers are visible.
- `user-language` ranks signal proximity before raw count and regenerates
  stale n-grams.
- `verification-gaps` was rewritten from a slow per-session scan to an
  edit-first aggregate.
- `codex-health` now ignores empty sessions and ranks by estimated context
  cost.
- Closure derivation now runs full-graph during ingest even when transcript
  ingest is since-scoped, because fix-chain rows are materialized comparisons.
- `interventions candidates` selects its ordered fields to satisfy SurrealDB
  ordering rules.
- `bun test`
- `bun run typecheck`
- `bun src/cli/index.ts project verify --json`

Live dogfood counts after the smoke:

- `tool_call`: 9,055
- `plan_snapshot`: 103
- `insight`: 131
- `friction_event`: 626
- `diagnostic_event`: 456

Schema coverage after the smoke: 25 of 40 tables populated. Empty staged
tables are `workspace`, `changeset`, `file_memory`, `artifact`,
`feedback_event`, `guidance`, `guidance_version`, and the future
changeset/artifact/provenance relation tables. `recommendation` is active but
conditional; it stays empty until repeated friction crosses the current
threshold.

Legacy self-improve importer behavior:

- `runs/*/events.jsonl` becomes stable `friction_event` rows with
  `source=legacy_self_improve`.
- `clusters.json`, `proposed-claudemd.md`, and `_spend.log` become compact
  `artifact` evidence plus `insight` summaries.
- `self_improve_run` records hold run-level counts, spend metrics, and event
  type totals.
- `has_artifact` and `derived_from` edges keep provenance queryable; the
  imported rows are evidence, not authoritative truth.

Install onboarding dogfood:

- `./dist/axctl onboarding --json` and `bun src/cli/index.ts onboarding
  --json` returned the same local harness tracking state.
- Claude global guidance and shared agent skills were already git-tracked.
- Codex global guidance was the only warning: `/Users/necmttn/.codex`.
- The install onboarding formatter produced a host-agent checklist scoped to
  that warning, with guidance to use `axctl onboarding --json`, track only
  guidance/hooks/skills/commands/settings, exclude transcripts/caches/logs/
  secrets/generated artifacts, commit `chore: track agent harness`, and rerun
  onboarding.

wterm terminal dogfood:

- `./dist/axctl dogfood terminal --scenario=axctl-setup --transport=pty
  --port=1744 --json` served a browser-rendered wterm terminal backed by a
  Node `node-pty` sidecar.
- `agent-browser open http://127.0.0.1:1742/` loaded the wterm DOM frontend and
  drove the scenario through the browser.
- The scratch setup scenario demonstrated `axctl --help`, initial
  `axctl onboarding --json` warnings for `.claude`, `.codex`, and
  `.agents`, host-agent-style git tracking of those harness dirs, and a second
  onboarding check returning all `ok`.
- Latest passing run wrote
  `intervention_observation:dogfood_wterm_setup__bea19103cb17318a` with
  `target=axctl_setup_wterm_dogfood`, `status=passed`, and
  `transport=pty`.
- The transcript was stored as
  `artifact:dogfood_wterm_setup__bea19103cb17318a__transcript`.
- Native `node-pty` inside Bun 1.3.10 was tested first but did not reliably
  stream PTY output, so the committed PTY path uses a Node sidecar and keeps
  `--transport=process` as a fallback. Free-running Claude-driver automation
  remains the next driver slice.
- Interactive mode now runs with
  `./dist/axctl dogfood terminal --scenario=interactive --transport=pty
  --command='bash -l' --port=1747 --json`. `agent-browser` drove the terminal
  by typing `echo AGENT_BROWSER_STEERED_INTERACTIVE`, then `exit`; the latest
  result was `status=completed`, `transport=pty`, and the transcript contained
  the typed marker.
- Agent presets now run with `--agent=shell|claude|codex|opencode`. Live smoke
  `--scenario=interactive --agent=shell --transport=pty --port=1748 --json`
  produced `intervention_observation:dogfood_wterm_interactive__1ab36f61a56036de`
  with `agent=shell`, `command=bash -l`, `command_source=preset`,
  `status=completed`, and a transcript containing `AGENT_PRESET_SHELL_STEERED`.
- Repeatable success criteria via `--success-marker=STR` and `--timeout=SECONDS`.
  Marker-pass live smoke
  `--scenario=interactive --agent=shell --transport=pty
  --success-marker=E2E_MARKER_PASS --timeout=20 --port=1749 --json`
  with `agent-browser` typing `echo E2E_MARKER_PASS; exit` returned
  `status=passed`, `markerFound=true`, `timedOut=false`, `persisted=true`.
  Timeout live smoke
  `--scenario=interactive --agent=shell --transport=pty
  --success-marker=NEVER_SEEN --timeout=2 --port=1750 --json`
  produced
  `intervention_observation:dogfood_wterm_interactive__a89b0b1b94e86f02`
  with `status=timed_out`, `metrics.timed_out=true`,
  `metrics.timeout_seconds=2`, `metrics.success_marker=NEVER_SEEN`, and
  `metrics.marker_found=false`.

Harness Doctor schema additions are populated by default ingest. If they are
empty, run `axctl ingest --since=1` and inspect the `harness/doctor` ingest
stage.

Dashboard generated at:

`file:///Users/necmttn/.local/share/ax/dashboard.html`

## Experiment Loop CLI (`axctl improve`)

`axctl improve` is the read-write surface on top of the experiment-loop tables
(`proposal`, `skill_proposal`, `experiment`, `checkpoint`). The loop:
**retro → proposal → experiment → verdict** (see `axctl retro` for the front
end). Subcommands:

### `axctl improve recommend`

Rank open proposals by `confidence × recency × frequency` and print them as
paste-ready blocks, each wrapped in `<!--ax:id-->` provenance markers so the
agent file edit is traceable back to the proposal.

Flags:

- `--limit=N` (default 5) - top N to print
- `--form=<skill|guidance|...>` (repeatable) - filter by proposal form
- `--since=N` - only proposals derived within N days
- `--json` - machine-readable
- `--no-clipboard` - skip auto-copy of top result
- `--apply` - interactive accept loop: pick a numbered row, accept, repeat

### `axctl improve accept <id>`

Default mode emits `.ax/tasks/<id>.md`, a structured brief your primary
agent (Claude Code, Codex, etc.) consumes to edit the target file with the
marker still in place. The brief tracks `task_emitted` status on the
experiment row.

Flags:

- `--auto-scaffold` - skip the brief, write `SKILL.md` directly under the
  scaffold dir (skill form only). Use when you want the file now and don't
  need a brief to hand off.
- `--with-agent` - after scaffold, spawn a `claude -p` subagent (bypass
  permissions, streaming to terminal) that reads the stub + sibling skills
  and rewrites `SKILL.md` with concrete triggers, steps, anti-patterns.
  Optionally writes a sibling `PLAN.md` with a 3-bullet experiment plan
  (what to measure, success criterion, kill criterion). Implies
  `--auto-scaffold` semantics.
- `--force` - overwrite an existing scaffold.

`<id>` accepts either the dedupe sig (12-char prefix from `recommend`) or the
full `proposal:<key>` record id.

### `axctl improve lint`

Scan grounded agent files for `<!--ax:id-->` markers and reconcile against
the DB:

- Markers in files but no matching proposal → orphan warning.
- `task_emitted` experiments whose `.ax/tasks/<id>.md` brief has been
  consumed (marker now lives in agent file) → consumed task file removed,
  experiment status advanced.
- Task briefs older than `--stale-days` (default 7) with no marker landed →
  stale warning, candidate for reject.

Flags:

- `--root=<dir>` (repeatable) - additional scan roots beyond CWD
- `--stale-days=N` (default 7)
- `--json`

Linter dedupes against `proposal.dedupe_sig` exactly and pushes the stale-task
date filter into SurrealQL, so it stays fast as the proposal table grows.

### `axctl improve show <id>`

Full evidence trail for one proposal: source retro(s), baseline cluster,
skill payload (trigger pattern, proposed behavior, expected impact), the
linked experiment row, scaffold path, checkpoint snapshots, locked verdict.

### `axctl improve list`

Browse the proposal queue.

Flags:

- `--status=<open|accepted|rejected|all>`
- `--form=<skill|guidance|...>`
- `--limit=N` (default 30)
- `--json`

### `axctl improve verdict <id>`

Inspect or lock the t+90 verdict.

Flags:

- `--set=<adopted|ignored|regressed|partial|no_longer_needed>` - lock the
  verdict (otherwise computed from checkpoints)

### `axctl improve reject <id>`

Mark proposal rejected. Future re-derives of the same trigger are deduped
against rejected proposals, so the same pattern won't re-propose every retro.

Flags:

- `--reason=<short_string>` (default `not_worth_packaging`) - tracked on the
  row for later analysis of what kinds of proposals get rejected.

### `axctl improve checkpoint`

Compute checkpoint snapshots at t+7/t+30/t+90 for active experiments. Cron-
runnable; the weekly self-improve cron will call this.

### `axctl improve reset --yes`

Wipe all experiment-loop state (proposals, experiments, checkpoints, skill
proposals). For test fixtures and local-only debugging. Requires `--yes`.

### Provenance markers

Every accepted proposal's edit is wrapped:

```markdown
<!--ax:a1b2c3d4e5f6-->
... agent-file content ...
<!--/ax:a1b2c3d4e5f6-->
```

The id is the proposal `dedupe_sig` prefix. `axctl improve lint` reconciles
both directions: orphan markers (DB has no proposal) and orphan proposals
(`task_emitted` but the brief was never consumed). Nested same-id close tags
are balanced; markers across multiple files for the same proposal are
allowed.

### `.ax/tasks/<id>.md` task briefs

When `axctl improve accept <id>` runs without `--auto-scaffold`/`--with-agent`,
it writes `.ax/tasks/<id>.md` with:

1. Target file path (e.g. `~/.claude/CLAUDE.md` or a skill `SKILL.md` path).
2. The exact paste-ready block (markers + content).
3. A `Lint after applying:` footer pointing at `axctl improve lint`.

The brief is plain markdown. Hand it to any agent; the agent's diff is what
lands in your config. `lint` reconciles the brief's existence against the
marker actually showing up in the target file.

## Retro CLI (`axctl retro`)

The retro surface tracks one structured reflection per session
(`tried`, `worked`, `failed`, `next`). A session has been retro'd iff
the graph has a `reviewed` edge from it to a `retro` row. See ADR-0010
for the design rationale.

### `axctl retro emit`

Write a retro for one session and create the `reviewed` edge.

Two paths:

- No `--from-file`: run the deterministic heuristic on the named
  session (defaults to `$AX_SESSION_ID`, then the most recent session).
  Cheap, no LLM. Suitable for Stop-hook autoemit.
- `--from-file=<path>`: ingest `{tried, worked, failed, next}` JSON
  written by an agent (the `retro-reviewer` subagent does this).
  `--source` defaults to `claude_stop_hook` here; pass
  `--source=manual` for subagent-authored payloads.

Flags:

- `--session=<id>` - target session record id or bare key
- `--from-file=<path>` - JSON payload to ingest
- `--source=<claude_stop_hook|codex_rollout|heuristic|manual>`
- `--json` - machine-readable

### `axctl retro pending`

List sessions in the window that have no `reviewed` edge. Drives the
`/retro` skill's Step 0 "drain the backlog" flow.

Two-pass query: ended sessions (`ended_at != NONE`) come first; idle
sessions (no `ended_at` AND `started_at` older than `--idle-min`) come
second. Subagent sessions (`source = 'claude-subagent'`) are excluded
by default - their retros belong to the parent session's review.

Flags:

- `--since=N` (default 7) - window in days
- `--idle-min=N` (default 30) - idle threshold in minutes for sessions
  without `ended_at`
- `--limit=N` (default 20) - per-pass cap
- `--include-subagents` - include `claude-subagent` rows
- `--json`

### `axctl retro brief`

Write a `.ax/tasks/retro/<session-key>.md` task brief for one session.
The brief is what the `retro-reviewer` subagent consumes. Frontmatter
includes the transcript pointer, model used, turn count, pending
reason, and a `suggested_model` heuristic (haiku for ≤5 turns, opus
for ≥40 turns, sonnet otherwise).

Flags:

- `--session=<id>` (required) - target session record id or bare key
- `--out-dir=<path>` - override `.ax/tasks/retro/` location
- `--json`

### `axctl retro list`

Browse recent retros (reverse-chronological).

Flags:

- `--since=N` (default 7) - window in days
- `--limit=N` (default 20)
- `--json`

### `axctl retro reflect`

Walk clustered retro-derived proposals interactively (accept / reject
/ skip each pattern). Used by the `/retro` skill's triage step; see
that skill for the full workflow.

### `axctl retro meta`

Emit a read-only investigation snapshot (JSON) for an external AI
agent to drive a deep retro-of-retros. Used by `/retro-meta`.

### `axctl retro plan`

Register an externally-drafted plan as a proposal (plus experiment
unless `--leave-open`). Called by an external agent after the user
agrees in a `/retro-meta` session.

### `.ax/tasks/retro/<session-key>.md` briefs

A retro brief is a markdown file with YAML frontmatter (`session_id`,
`session_key`, `transcript`, `model_used`, `turns`, `pending_reason`,
`suggested_model`, `status: pending`) and a body describing what the
reviewer should produce. The `retro-reviewer` subagent reads it, calls
`ax retro emit --source=manual`, optionally calls `ax improve
recommend` for repeated patterns, and updates the brief's frontmatter
`status: completed`. The `reviewed` edge created by `ax retro emit`
removes the session from the next `ax retro pending` result.

These briefs live next to the older `.ax/tasks/<id>.md` improve briefs
but in their own subdir to keep listings clean.

## Empty DB Benchmarks

Use `scripts/bench-empty-db.sh` for cold ingest timing without mutating
`ax/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

The script selects a unique `AX_DB_DB=bench_<timestamp>`, applies the
schema, runs ingest, imports Claude insights, writes `schema.json`,
`checkouts.json`, and `git.json`, and generates a static dashboard under
`~/.local/share/ax/benchmarks/<db>/`.

Repo initialization is not per-project. Ingest discovers repositories from
existing transcript `cwd` values and optionally from
`~/.local/share/ax/ax-repos.txt`. The Git pass backfills
`session.repository` and `session.checkout`; `produced` edges are then tied to
the checkout plus commit timestamp, while `touched` edges connect commits to
canonical repository-relative files.

The final ingest smoke also found and fixed a plan-item identity bug: plan item
records now use plan+sequence identity, and the writer deletes legacy
content-hashed item rows that conflict on the `plan_item_plan_seq` unique index
before upserting the canonical row.
