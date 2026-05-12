# Repository Evidence Graph Queries

`src/queries/insights.ts` is the shared adapter for dashboard-grade evidence
graph queries. CLI, TUI, and integration tests should reuse these builders
instead of embedding ad hoc SurrealQL that can drift from the schema.

Example commands:

```bash
agentctl insights
agentctl insights schema
agentctl insights repositories --limit=25
agentctl insights checkouts --limit=25
agentctl insights git --limit=25
agentctl insights friction --limit=50
agentctl insights tools --limit=20
agentctl insights sessions --limit=20
agentctl insights feedback-loops --limit=20
agentctl insights verification-gaps --limit=20
agentctl insights user-language --limit=20
agentctl insights token-impact --limit=20
agentctl insights cache-health --limit=20
agentctl insights workflow-impact --limit=20
agentctl insights codex-health --limit=20
agentctl insights closure --limit=20
agentctl insights post-feature-fixes --limit=20
agentctl insights skill-candidates --limit=20
agentctl insights graph-health --limit=10
agentctl dashboard --limit=25
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

- `agentctl project harness` scans repo-local and global guidance sources at
  report time.
- `agentctl project harness --json` returns Guidance Sources, Guidance
  Revisions, Stack signals, Agent Tooling signals, Harness Doctor findings, the
  first local Harness Learning candidate, an Intervention suggestion, and an
  Intervention Observation.
- `agentctl project harness` also reads existing `tool_call`, `edited`, and
  `produced` graph evidence so observed tooling and main-branch write-risk
  signals are grounded in the current database.
- Default `agentctl ingest` persists the Harness Doctor report into the staged
  Harness Doctor tables via the `harness/doctor` ingest stage.
- Default `agentctl ingest` also persists command outcome classifications and
  user-message n-grams via the `outcomes/derive` ingest stage.
- Default `agentctl ingest` persists token/cache/workflow health via the
  `session-health/derive` ingest stage.
- Default `agentctl ingest` persists commit lifecycle, post-feature fix-chain,
  and skill-candidate records via the `closure/derive` ingest stage.
- Default `agentctl ingest` persists gotchas, taste signals, workflows,
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

Use `agentctl project harness --json` as the canonical report surface and
`agentctl insights schema` to verify durable table population after ingest.

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

`agentctl onboarding --json` checks whether global Claude, Codex, and shared
agent guidance directories are git-tracked. This gives future guidance and
skill experiments commit evidence before agentctl starts recommending harness
changes.

`agentctl interventions list|impact|regressions|candidates --json` is the first
read surface for intervention lifecycle work: proposed interventions, measured
observations, high-risk regression sessions, and candidate skills.

SurrealKit workflow takeaway: local development can keep importing the schema
directly for now. Tests should prefer isolated databases or namespaces so
query/integration runs do not mutate the user's main `agentctl/main` graph.
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

- `./dist/agentctl onboarding --json` and `bun src/cli/index.ts onboarding
  --json` returned the same local harness tracking state.
- Claude global guidance and shared agent skills were already git-tracked.
- Codex global guidance was the only warning: `/Users/necmttn/.codex`.
- The install onboarding formatter produced a host-agent checklist scoped to
  that warning, with guidance to use `agentctl onboarding --json`, track only
  guidance/hooks/skills/commands/settings, exclude transcripts/caches/logs/
  secrets/generated artifacts, commit `chore: track agent harness`, and rerun
  onboarding.

wterm terminal dogfood:

- `./dist/agentctl dogfood terminal --scenario=agentctl-setup --transport=pty
  --port=1744 --json` served a browser-rendered wterm terminal backed by a
  Node `node-pty` sidecar.
- `agent-browser open http://127.0.0.1:1742/` loaded the wterm DOM frontend and
  drove the scenario through the browser.
- The scratch setup scenario demonstrated `agentctl --help`, initial
  `agentctl onboarding --json` warnings for `.claude`, `.codex`, and
  `.agents`, host-agent-style git tracking of those harness dirs, and a second
  onboarding check returning all `ok`.
- Latest passing run wrote
  `intervention_observation:dogfood_wterm_setup__bea19103cb17318a` with
  `target=agentctl_setup_wterm_dogfood`, `status=passed`, and
  `transport=pty`.
- The transcript was stored as
  `artifact:dogfood_wterm_setup__bea19103cb17318a__transcript`.
- Native `node-pty` inside Bun 1.3.10 was tested first but did not reliably
  stream PTY output, so the committed PTY path uses a Node sidecar and keeps
  `--transport=process` as a fallback. Free-running Claude-driver automation
  remains the next driver slice.

Harness Doctor schema additions are populated by default ingest. If they are
empty, run `agentctl ingest --since=1` and inspect the `harness/doctor` ingest
stage.

Dashboard generated at:

`file:///Users/necmttn/.local/share/agentctl/dashboard.html`

## Empty DB Benchmarks

Use `scripts/bench-empty-db.sh` for cold ingest timing without mutating
`agentctl/main`:

```bash
scripts/bench-empty-db.sh --since=90
```

The script selects a unique `AGENTCTL_DB_DB=bench_<timestamp>`, applies the
schema, runs ingest, imports Claude insights, writes `schema.json`,
`checkouts.json`, and `git.json`, and generates a static dashboard under
`~/.local/share/agentctl/benchmarks/<db>/`.

Repo initialization is not per-project. Ingest discovers repositories from
existing transcript `cwd` values and optionally from
`~/.local/share/agentctl/agentctl-repos.txt`. The Git pass backfills
`session.repository` and `session.checkout`; `produced` edges are then tied to
the checkout plus commit timestamp, while `touched` edges connect commits to
canonical repository-relative files.

The final ingest smoke also found and fixed a plan-item identity bug: plan item
records now use plan+sequence identity, and the writer deletes legacy
content-hashed item rows that conflict on the `plan_item_plan_seq` unique index
before upserting the canonical row.
