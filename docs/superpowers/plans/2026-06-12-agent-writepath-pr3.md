# Agent Write-Path (PR3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents can write rich proposals into the improve loop: `ax improve analyze` emits a mining brief, `ax improve propose` inserts validated proposals with `origin: "agent"`, and the dashboard surfaces origin + a "Run deep analysis" copy button.

**Architecture:** `origin` is an additive SCHEMAFULL field (DEFAULT 'mined'; old rows read NONE → coalesce in JS). `propose` mirrors the retro derivation pattern (fresh `dedupe_sig` → CREATE proposal; existing → frequency bump; per-form payload UPSERT) via pure statement builders + one Effect runner. The analyze brief is one template module shared by the CLI (writes `.ax/tasks/`) and a new GET endpoint (dashboard copies it to clipboard).

**Tech Stack:** Effect 4 beta, effect Schema for input validation, bun:test. Studio: React/TanStack.

**Spec:** `docs/superpowers/specs/2026-06-12-improve-first-dashboard-design.md` (PR4 section covers wrapped; this is PR3 scope).

**Hard-won rules:** new endpoint ⇒ register in `baseApiCapabilities` AND `mock-fixtures.ts`. `/api/improve` is legacy-only (not contract) - single wiring point `improve-proposals.ts`. No new table ⇒ no SCHEMA_TABLES change.

---

### Task 1: `origin` field end-to-end (read side)

- [ ] `packages/schema/src/schema.surql` proposal block: `DEFINE FIELD origin ON proposal TYPE string DEFAULT 'mined';`
- [ ] `ProposalDto` gains `readonly origin?: string` (dashboard-types).
- [ ] `apps/axctl/src/dashboard/improve-proposals.ts`: PROPOSALS_SQL selects `origin`; `withBrief` mapper coalesces `origin: p.origin ?? "mined"` (old rows = NONE).
- [ ] Test: improve-proposals.test.ts asserts coalesce for a row without origin.
- [ ] Gate: dashboard tests + typecheck. Commit `feat(improve): proposal origin field, mined default`.

### Task 2: propose core (TDD)

**Files:** Create `apps/axctl/src/improve/propose.ts` + `propose.test.ts`.

- [ ] `ProposeInput` Schema: `{ form: Literals(skill|subagent|hook|guidance|automation), title, hypothesis, confidence: Literals(high|medium|low), frequency?: int>=1 (default 1), evidence?: string, payload: per-form struct }` - payload field shapes copied from schema.surql payload tables (skill: trigger_pattern/suspected_gap/proposed_behavior/expected_impact?; subagent: bounded_role/delegation_trigger/example_task_patterns?; hook: event_name/target_tool?/hook_command + safety fields?; guidance: file_target/section?/suggested_text; automation: trigger_signal/schedule?/action + safety fields?).
- [ ] `buildProposeStatements(input, sig)` pure: mirrors `buildRetroSkillProposalStatements` (apps/axctl/src/ingest/derive-retro-proposals.ts:390 - CREATE-if-fresh with `origin: 'agent'`, else frequency bump + updated_at; payload UPSERT both paths). Reuse `dedupeSig`/`normalizeTitle` from `apps/axctl/src/ingest/derive-proposals.ts:283-286` and the `surrealString/surrealObject` helpers the retro builder uses.
- [ ] `runPropose(input)` Effect: validate → sig → statements → db.query → return `{ status: "created" | "bumped", sig }` (detect via SELECT before, like retro does).
- [ ] Tests: schema rejects bad form/missing payload field; statement builder snapshot for skill + guidance forms (origin 'agent' present, payload UPSERT); bump path.
- [ ] Commit `feat(improve): propose core - validated agent proposal insert`.

### Task 3: CLI subcommands

- [ ] `apps/axctl/src/improve/analyze-brief.ts`: `renderAnalyzeBrief({ date, repoHint })` pure template - instructs the agent to mine `ax sessions churn`, `ax dispatches --candidates`, `ax recall`, tool failures + MCP read tools; one proposal per durable pattern with evidence refs (session ids, sigs, $); emit each via `echo '<json>' | ax improve propose`; documents the ProposeInput JSON shape per form. Test: contains the propose command, all 5 forms, evidence requirement.
- [ ] `cli/commands/improve.ts`: subcommand `propose` (reads stdin, `--file=` override) → runPropose, prints JSON result; subcommand `analyze` → writes `.ax/tasks/analyze-improve-<YYYY-MM-DD>.md` (mkdir -p, no overwrite without `--force`), prints path. Follow the existing subcommand registration style in that file.
- [ ] Commit `feat(cli): ax improve propose + analyze`.

### Task 4: analyze-brief endpoint

- [ ] GET `/api/improve/analyze-brief` (improve routes family, static path BEFORE `/:sig/:action` - method differs but keep above it) → `{ brief: string }` via `renderAnalyzeBrief`.
- [ ] `baseApiCapabilities` += `"improve-analyze"`; mock fixture for the path; `api.improveAnalyzeBrief()` client method.
- [ ] Route-match test. Commit `feat(dashboard): analyze-brief endpoint`.

### Task 5: studio surfacing

- [ ] Improve route header: "Run deep analysis" `CopyButton`-style button fetching the brief once (useQuery, staleTime Infinity) and copying on click - label "Copy analysis brief".
- [ ] Proposals table + detail: `agent` badge when `origin === "agent"` (badge keep styling); table rank score: agent gets +0.5 tiebreak above mined at equal confidence×frequency (and same tweak in `proposalCards` bonus server-side: `+ bonus(... + (origin === "agent" ? 1 : 0))`).
- [ ] Build + studio typecheck. Commit `feat(studio): agent origin badge + run deep analysis`.

### Task 6: gate + live smoke + PR

- [ ] `bun test` + typecheck + build. Live: side-port daemon; `echo '{"form":"guidance",...}' | ./apps/axctl/bin/axctl improve propose` → /api/improve shows it with origin agent; re-propose bumps frequency; `ax improve analyze` writes the brief; GET analyze-brief returns it. Schema field on live DB: ensure `ax ingest`-applied schema or manual DEFINE on the dev DB (schema.surql applies via db lifecycle scripts - check scripts/ for schema apply command and run it).
- [ ] Push + PR; merge only at CLEAN.
