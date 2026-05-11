# Graph Insight Backlog Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining `docs/graph-insight-goal-notes.md` backlog as dogfoodable, committed vertical slices.

**Architecture:** Keep observed evidence in existing normalized tables, add derived tables for higher-level insight products, and expose every slice through CLI JSON first. Each slice must be idempotent, testable with pure builders, dogfooded against the local graph, and committed before moving on.

**Tech Stack:** Bun, TypeScript, Effect v4, SurrealDB 3, existing `agentctl` CLI and schema patterns.

---

## Completion Slices

### Task 1: Persist Harness Doctor Rows

**Files:**
- Create: `src/ingest/harness.ts`
- Create: `src/ingest/harness.test.ts`
- Modify: `src/cli/index.ts`
- Modify: `schema/schema.surql`
- Modify: `docs/insights-cli-reference.md`

- [x] Add idempotent statement builders for `guidance_source`, `guidance_revision`, `stack`, `agent_tooling`, `harness_learning`, `intervention`, and `intervention_observation`.
- [x] Add `ingestHarness()` that calls `buildProjectHarnessReport()` and writes the rows.
- [x] Add ingest stage `harness/doctor` after `signals/derive`.
- [x] Dogfood: run `agentctl ingest --since=1`, then `agentctl insights schema` and verify the staged harness tables populate.
- [x] Commit: `feat: persist harness doctor evidence`.

### Task 2: Command Outcome + User Language Signals

**Files:**
- Create: `src/ingest/outcomes.ts`
- Create: `src/ingest/outcomes.test.ts`
- Modify: `schema/schema.surql`
- Modify: `src/ingest/derive-signals.ts`
- Modify: `src/queries/insights.ts`
- Modify: `src/cli/index.ts`

- [ ] Add `command_outcome` table and classify command failures as `expected_feedback`, `search_miss`, `guardrail`, `environment_blocker`, `workflow_error`, `product_bug_signal`, or `unknown`.
- [ ] Add `user_message_ngram` table from `turn.role = "user"` excerpts.
- [ ] Add CLI views: `agentctl insights feedback-loops`, `verification-gaps`, and `user-language`.
- [ ] Dogfood: run derive/ingest and inspect the top n-grams plus feedback-loop classifications.
- [ ] Commit: `feat: derive command outcomes and user language`.

### Task 3: Token, Cache, Workflow, And Codex Insight Health

**Files:**
- Create: `src/ingest/session-health.ts`
- Create: `src/ingest/session-health.test.ts`
- Modify: `schema/schema.surql`
- Modify: `src/ingest/codex.ts`
- Modify: `src/ingest/claude-insights.ts`
- Modify: `src/queries/insights.ts`
- Modify: `src/cli/index.ts`

- [ ] Add `session_token_usage`, `workflow_epoch`, and derived health records.
- [ ] Extract available Claude token/cache metrics from usage metadata.
- [ ] Extract Codex token/cache/context/interruption/goal/delegation signals from raw telemetry already ingested.
- [ ] Add CLI views: `token-impact`, `cache-health`, `workflow-impact`, and `codex-health`.
- [ ] Dogfood: compare recent Superpowers-era sessions against older sessions using available proxies.
- [ ] Commit: `feat: derive session token and workflow health`.

### Task 4: Post-Closure Quality And Skill Candidates

**Files:**
- Create: `src/ingest/closure.ts`
- Create: `src/ingest/closure.test.ts`
- Modify: `schema/schema.surql`
- Modify: `src/ingest/derive-signals.ts`
- Modify: `src/queries/insights.ts`
- Modify: `src/cli/index.ts`

- [ ] Add commit classification: feature, fix, refactor, test, docs, chore.
- [ ] Derive feature-to-later-fix relations using time window plus overlapping files.
- [ ] Add `skill_candidate` records from repeated fix chains, corrections, and verification gaps.
- [ ] Add CLI views: `closure`, `post-feature-fixes`, and `skill-candidates`.
- [ ] Dogfood: inspect this repo's recent feature/fix chains and candidate skills.
- [ ] Commit: `feat: derive closure quality and skill candidates`.

### Task 5: Intervention, Onboarding, Registry, Taste, Gotchas, Matching

**Files:**
- Create: `src/ingest/learning-registry.ts`
- Create: `src/ingest/learning-registry.test.ts`
- Create: `src/cli/onboarding.ts`
- Modify: `schema/schema.surql`
- Modify: `src/cli/index.ts`
- Modify: `README.md`

- [ ] Add lifecycle commands for interventions: list, show, impact, regressions, candidates.
- [ ] Add onboarding checks for global/local guidance tracking and dotfiles recommendations.
- [ ] Add `gotcha`, `taste_signal`, `workflow`, `learning_feedback`, `learning_match`, and `adoption` schema and seed derivations.
- [ ] Add lean Stack/Workflow matching for Harness Learnings.
- [ ] Keep hosted hub, public taste cards, and auto-publishing local-only/draft-only.
- [ ] Dogfood onboarding against this machine and verify weak evidence warnings are useful.
- [ ] Commit: `feat: add learning registry and onboarding loop`.

### Task 6: E2E Dogfood And Iteration

**Files:**
- Modify: `docs/insights-cli-reference.md`
- Modify: `README.md`
- Modify: code touched by findings

- [ ] Run full pipeline: schema, ingest, ingest-insights, derive-signals, project harness, new insight views, dashboard, tests, typecheck, build.
- [ ] Save dogfood notes in `docs/insights-cli-reference.md`.
- [ ] Fix confusing output, slow queries, duplicate edges, or false positives found during dogfood.
- [ ] Commit: `test: dogfood graph insight backlog`.
