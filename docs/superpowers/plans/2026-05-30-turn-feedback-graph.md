# Turn Feedback Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local heuristic turn-feedback graph with immediate insight read paths.

**Architecture:** Add schema tables/relations, a pure classifier, a derive stage, and two read queries. The derive stage reads `turn`, writes `turn_analysis`, promotes stable `semantic_signal` nodes, and writes `expresses` / `reacts_to` edges.

**Tech Stack:** Bun, TypeScript, Effect, SurrealDB schemafull tables, existing StageRegistry and insights query patterns.

---

### Task 1: Schema

**Files:**
- Modify: `schema/schema.surql`
- Test: `schema/schema.test.ts`

- [x] Add `turn_analysis`, `semantic_signal`, `expresses`, and `reacts_to`.
- [x] Add schema tests that assert all four tables and useful indexes exist.
- [x] Run `bun test schema/schema.test.ts`.

### Task 2: Classifier

**Files:**
- Create: `src/ingest/turn-analysis.ts`
- Create: `src/ingest/turn-analysis.test.ts`

- [x] Define row/input/output types.
- [x] Implement `classifyTurnAnalysis(row)`.
- [x] Implement stable `semanticSignalKey` mapping.
- [x] Test approval, correction, rejection, exploration, assistant blocker, assistant verification, and neutral cases.
- [x] Run `bun test src/ingest/turn-analysis.test.ts`.

### Task 3: Derive Writer

**Files:**
- Modify: `src/ingest/turn-analysis.ts`
- Test: `src/ingest/turn-analysis.test.ts`

- [x] Add statement builders for `turn_analysis`, `semantic_signal`, `expresses`, and `reacts_to`.
- [x] Add `deriveTurnAnalysis({ sinceDays })` Effect that fetches turns with previous assistant context.
- [x] Make the stage idempotent by deterministic record keys and scoped deletes.
- [x] Test statement output and derived relationships from a small turn window.

### Task 4: Stage Registry

**Files:**
- Modify: `src/ingest/stage/registry.ts`
- Modify: `src/ingest/run.ts`
- Test: add or update stage registry tests.

- [x] Register `turn-analysis` after `outcomes` / `signals`.
- [x] Add run event label `{ source: "turn-analysis", stage: "derive" }`.
- [x] Run registry and runner-focused tests.

### Task 5: Read Queries

**Files:**
- Modify: `src/queries/insights.ts`
- Modify: `docs/insights-cli-reference.md` if the CLI reference lists insight views manually.
- Test: `src/queries/insights.test.ts` or existing insight query tests.

- [x] Add `message-signals` SQL.
- [x] Add `feedback-language` SQL.
- [x] Add tests that generated SQL references `turn_analysis`, `semantic_signal`, `expresses`, and example fields.
- [x] Run `bun test src/queries/insights.test.ts`.

### Task 6: Verification

- [x] Run focused tests for schema, turn analysis, registry, and insights.
- [x] Run `bun test`.
- [x] Run `bun run typecheck`; if unrelated existing errors remain, report them separately.
