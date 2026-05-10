# Original Inspiration Completion Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each linked issue task-by-task. This roadmap is a sequencing map; each linked issue should get its own implementation plan before code changes.

**Goal:** Turn the current evidence-graph prototype into the original product shape: reusable agent memory, recall, concept resolution, measured guidance, live inspection, structure tracing, runtime telemetry, and stronger Effect boundaries.

**Architecture:** Keep the current activity-first graph as the foundation. Add derived product-layer records only after they can point back to concrete sessions, turns, tool calls, files, commits, diagnostics, or guidance evidence. Prefer read-only JSON/CLI surfaces before automatic instruction rewriting or broad migrations.

**Tech Stack:** Bun, TypeScript, Effect, SurrealDB, GitHub issues, existing `agentctl` CLI/dashboard modules.

---

## Current State

- `main` is clean and synced with `origin/main`.
- GitHub has no pre-existing open issues before this roadmap.
- Core graph evidence is active: sessions, turns, tool calls, repositories, checkouts, files, commits, plans, friction, diagnostics, produced/touched/edited/concerns edges.
- Staged product-layer tables exist but are not fully active: `changeset`, `file_memory`, `feedback_event`, `guidance`, `guidance_version`, `includes`, `involves`, `resulted_in`, `supersedes`, artifact relations.
- `agentctl dashboard serve` exists, but the complete product UI is still an open workstream.
- `agentctl guidance next --json`, `agentctl session summary --json`, and `agentctl self-improve weekly --json` exist, but the full guidance lifecycle and outcome loop is incomplete.
- `bun run typecheck` exits `0`, with remaining Effect advisory messages around direct JSON APIs and one `Effect.void` style note.

## Issue Map

1. [#64 Build activity-first project memory from changesets and file memories](https://github.com/Necmttn/agentctl/issues/64)
2. [#65 Add recall command across sessions, commands, commits, files, and memory](https://github.com/Necmttn/agentctl/issues/65)
3. [#66 Resolve project concepts to files, commands, sessions, and commits](https://github.com/Necmttn/agentctl/issues/66)
4. [#67 Complete guidance lifecycle with outcome tracking](https://github.com/Necmttn/agentctl/issues/67)
5. [#68 Productize live dashboard views for graph health, worktrees, queries, and self-improve](https://github.com/Necmttn/agentctl/issues/68)
6. [#69 Add activity-first code structure tracing around touched files](https://github.com/Necmttn/agentctl/issues/69)
7. [#70 Ingest OTEL and dev-run diagnostics into the evidence graph](https://github.com/Necmttn/agentctl/issues/70)
8. [#71 Finish Effect service-boundary adaptation and schema decoders](https://github.com/Necmttn/agentctl/issues/71)

## Recommended Sequence

### Phase 1: Product Memory Core

Start with #64. `changeset` and `file_memory` are the missing bridge between raw evidence and useful project memory. Most later features get better if they can retrieve compact memory records instead of raw transcript fragments.

Then implement #65. `recall` should read the memory created by #64 plus existing evidence tables. Keep the first recall version lexical/BM25 and graph-reference based; do not introduce embeddings yet.

Then implement #66. Entity resolution should reuse recall and memory queries, but return typed candidates with reasons rather than narrative answers.

### Phase 2: Self-Improve Product Loop

Implement #67 after #64/#65. Guidance outcome tracking needs durable evidence and recallable memory so a proposed rule can point to before/after behavior instead of only recent counters.

Implement the self-improve portions of #68 after #67. The UI should inspect real guidance lifecycle state rather than mock a future flow.

### Phase 3: Inspection Surface

Implement the graph health, worktree, query workbench, and ingest live parts of #68. The server and SSE plumbing already exist; this phase should turn them into a reliable local workflow.

### Phase 4: Deeper Context Sources

Implement #69 for activity-first code structure tracing. Keep it scoped to recently touched/edited/queried files and TypeScript first.

Implement #70 for OTEL/dev-run diagnostics after the graph and UI have stable places to show runtime evidence.

### Phase 5: Architecture Hardening

Work #71 in parallel only when it is not destabilizing active product work. Prioritize service boundaries that help test #64-#70: config, process execution, diagnostics, and schema decoding at graph write/query boundaries.

## Non-Goals For This Roadmap

- Do not add semantic embeddings before `changeset` and `file_memory` are populated and queryable.
- Do not automatically rewrite durable agent instruction files before guidance acceptance/rejection and outcome measurement exist.
- Do not perform destructive graph migrations without graph-health reports and compatibility lookups.
- Do not build full-repository code indexing before activity-first tracing around touched files proves useful.

## Completion Gate

This roadmap is complete when each linked issue is closed with:

- A committed implementation or an explicit documented decision to drop/replace the work.
- Focused tests for its new derivation, query, command, dashboard, or service behavior.
- A smoke command showing the feature on an empty or recent-ingest database.
- README or docs updates for any new user-facing command.
- `bun test` and `bun run typecheck` passing, with any remaining advisories intentional and documented.

