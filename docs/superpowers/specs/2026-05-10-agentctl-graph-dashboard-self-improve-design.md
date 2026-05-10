# Agentctl Graph, Dashboard, and Self-Improve Design

Date: 2026-05-10

## Purpose

`agentctl` should become a dependable local evidence graph for AI coding agents. The next slice should clean up identity, use SurrealDB's graph and record-reference model more directly, expose realtime ingestion and query visibility, and create the foundation for self-improving agent guidance.

The core outcome is not just more tables. It is a coherent graph where sessions, turns, tools, files, repositories, checkouts, plans, guidance, and outcomes can be queried cheaply and interpreted consistently.

## Scope

This design covers three connected workstreams:

1. Cohesive IDs and SurrealDB graph cleanup.
2. Realtime browser dashboard for ingestion, graph health, and ad hoc queries.
3. AI harness self-improvement loop built from the graph's evidence.

Implementation should stay activity-first. Capture durable raw evidence and direct references first, then add heavier semantic ranking, search, and derived guidance once the graph is trustworthy.

## Current Problems

Identity is split across ingestion paths. Git-ingested files and transcript-edited files can refer to the same path with different IDs. Repository identity can shift from local or initial-commit identities to remote identities. Skill IDs currently use `:` to `__` encoding, which can collide for names such as `a:b` and `a__b`.

Some high-value graph edges are too bare. `produced` does not carry repository, checkout, or timestamp fields, which makes scoped cleanup and indexed dashboard queries harder. Some relations are better modeled as SurrealDB record references when the relationship is direct ownership rather than an event with payload.

The dashboard is currently report-oriented, not realtime. It can show snapshots, but it cannot make ingestion progress, failures, or query results visible as work happens.

The self-improve loop exists as an aspiration in hooks and cronjobs, but the graph does not yet provide stable enough evidence, metrics, and feedback records to safely recommend or evaluate agent guidance.

## Design Principles

Use stable identity before clever derivation. IDs should be versioned, deterministic where useful, collision-resistant, and centralized in shared helpers.

Use SurrealDB `REFERENCE` fields for direct ownership and containment. Keep relation tables where the edge itself has event meaning, payload, timestamps, metrics, or provenance.

Optimize for explainable agent feedback. Every recommendation should trace back to concrete evidence and measurable outcomes.

Build dashboard features around workflows: watch ingestion, inspect graph health, understand worktrees, query evidence, and review self-improvement suggestions.

## Identity Model

Create one shared identity module for all ingestion paths. It should own IDs for repositories, checkouts, files, commits, skills, tools, sessions, turns, tool calls, plans, and plan items.

Repository identity:

- Prefer canonical remote identity when a remote URL is available.
- Keep aliases for local path and initial-commit identities.
- Avoid rewriting existing records in ways that break historical references.
- Provide lookup helpers that can resolve old `local__`, `initial__`, and `remote__` identities to the canonical repository.

Checkout identity:

- Represent a local repository checkout or worktree.
- Key by repository plus normalized root path when repository identity is known.
- Keep raw absolute path only as evidence, not as the primary cross-table identity.

File identity:

- Prefer repository plus repo-relative path.
- Use checkout-local path identity only when repository cannot be determined.
- Migrate transcript edit ingestion to the same file ID helper used by Git ingestion.

Commit identity:

- Key by repository plus full SHA.
- Avoid allowing repository key transitions to create sibling commit records for the same canonical repository and SHA.

Skill and tool identity:

- Replace `:` to `__` lossy encoding with a versioned, collision-safe encoding.
- Keep compatibility lookup for existing skill IDs.

Conversation identity:

- Centralize session, turn, tool call, plan, and plan item ID helpers.
- Remove duplicated turn-key logic in Claude and Codex ingestion.

## SurrealDB Graph Model

Use `REFERENCE` fields for direct ownership:

- `session.repository`
- `session.checkout`
- `turn.session`
- `tool_call.session`
- `tool_call.turn`
- `tool_call.tool`
- `plan.session`
- `plan_item.plan`
- `plan_snapshot.plan`
- `plan_snapshot.tool_call`

These references allow direct forward access and reverse traversal with SurrealDB's `<~` syntax. That should simplify common queries such as "all tool calls for this turn", "all turns in this session", and "all sessions for this checkout".

Keep relation tables where the edge has meaning beyond ownership:

- `edited`: transcript evidence that an agent edited a file.
- `touched`: Git evidence that a commit touched a file.
- `produced`: a session or tool call produced a file or output artifact.
- `concerns`: a plan item, review, or guidance item concerns a file, tool, repository, checkout, or behavior.
- `derived_from`: derived records trace to raw evidence.
- `resulted_in`: recommendations or guidance versions trace to observed outcomes.

`produced` should become a valued relation with top-level fields:

- `repository`
- `checkout`
- `session`
- `tool_call`
- `ts`
- `source`
- `kind`

Add indexes for dashboard and cleanup paths, especially `(repository, checkout, ts)`, `(session, ts)`, and file endpoint lookups where SurrealDB supports the pattern cleanly.

`touched` should get deterministic relation IDs or uniqueness protection for `(commit, file, checkout)` so repeated Git ingestion remains idempotent without broad delete scans.

## Migration Strategy

Start with graph health checks before destructive migration:

- Duplicate file IDs for the same repository-relative path.
- Sibling repositories that differ only by local, initial, or remote key.
- Produced edges missing repository or checkout.
- Edited files that do not join to Git-touched files.
- Skill IDs with ambiguous lossy encodings.

Then migrate high-impact paths:

1. Introduce shared identity helpers and compatibility resolvers.
2. Update transcript file edit ingestion to use canonical file IDs.
3. Backfill `produced` with repository, checkout, and timestamp where evidence is available.
4. Add schema fields and indexes for references and valued edges.
5. Add health commands and dashboard panels to expose remaining drift.

Avoid a single risky rewrite. Prefer compatibility reads, incremental backfills, and health panels that show what remains.

## Realtime Dashboard

Add a browser dashboard command:

```sh
agentctl dashboard serve --port=1738
```

The server should be a Bun HTTP server with:

- Static dashboard assets.
- JSON API routes for graph health, worktrees, query samples, and self-improve data.
- WebSocket or SSE stream for ingestion events.
- SurrealDB live queries where useful and reliable.
- Polling fallback for local environments where live queries are not available.

Primary views:

- Ingest Live: active runs, stages, event log, row counts, failures, duration.
- Graph Health: duplicate identities, orphaned references, stale edges, join quality.
- Worktrees: repositories, checkouts, sessions, commits, touched files, produced artifacts.
- Query Workbench: saved queries, ad hoc SurrealQL, result table, copied JSON.
- Agent Activity: recent sessions, turns, tools, failures, plans, changed files.
- Self-Improve: detected signals, suggested guidance, accepted or rejected changes, measured outcomes.

Telemetry tables:

- `ingest_run`
- `ingest_stage`
- `ingest_event`
- `query_sample`
- `graph_health_check`

The dashboard should make ingestion and graph quality visible before it tries to become a full product UI.

## Query Surface

Keep CLI and dashboard query code behind shared query adapters. This prevents schema and taxonomy changes from leaking into UI code.

Useful agent-facing commands:

```sh
agentctl project context --json
agentctl project verify --json
agentctl guidance next --json
agentctl session summary --json
agentctl self-improve weekly --json
```

Useful human-facing dashboard actions:

- Run graph health checks.
- Open a repository or checkout.
- Inspect why a recommendation exists.
- Save a useful query sample.
- Compare guidance versions against outcomes.

## Self-Improve Loop

The loop should be explicit and reversible:

1. Observe raw evidence from transcripts, Git, tools, hooks, and verification commands.
2. Derive signals from repeated failures, missing verification, root-worktree edits, abandoned plans, tool friction, and repeated corrections.
3. Recommend guidance with provenance.
4. Apply guidance through an agent-facing file, hook, or command output.
5. Measure outcomes after later sessions.
6. Keep, revise, or revert the guidance.

Guidance records:

- `guidance`
- `guidance_version`
- `feedback_event`
- `derived_from`
- `resulted_in`

Each guidance version should include:

- Scope: global, project, repository, checkout, skill, tool, or workflow.
- Evidence summary.
- Proposed instruction.
- Risk level.
- Status: proposed, accepted, active, superseded, rejected, reverted.
- Metrics before and after activation.

Candidate signals:

- Repeated command failures.
- Repeated TypeScript, test, or lint failures.
- Edits in the main worktree when a worktree was expected.
- Missing verification before completion.
- Abandoned plans.
- Files frequently changed together.
- Tool calls that fail or require repeated retries.
- Skills that are relevant but not used.
- Hook or cron recommendations that correlate with improved outcomes.

Outcome metrics:

- Fewer repeated failures.
- Shorter recovery time after failure.
- Better verification coverage.
- Fewer user corrections for the same issue.
- Lower recurrence of previously flagged workflow mistakes.

## Error Handling

Ingestion events should record failures without losing the run. A failed stage should include source, stage, message, recoverability, and partial counts.

Dashboard API errors should be structured JSON with stable error codes. The UI should show failed queries, database connectivity problems, and live-query fallback state without hiding the rest of the dashboard.

Migration and backfill commands should default to dry-run or health-report modes when there is any risk of rewriting existing graph identity.

## Testing

Identity helpers need unit tests for:

- Remote repository normalization.
- Local and initial identity fallback.
- Legacy ID compatibility.
- File IDs from Git and transcript ingestion joining to the same record.
- Skill names that previously collided.

Schema and query tests need coverage for:

- `REFERENCE` forward and reverse traversal assumptions.
- `produced` filtering by repository, checkout, session, and timestamp.
- Idempotent `touched` writes.
- Graph health checks.

Dashboard tests need coverage for:

- Ingest event stream parsing.
- Query workbench API behavior.
- Graph health rendering.
- Failure state rendering.

Self-improve tests need coverage for:

- Signal derivation from known evidence fixtures.
- Guidance provenance.
- Outcome metric calculation.
- Rejection and revert behavior.

## Implementation Order

1. Add graph health checks and query adapters for current drift.
2. Centralize identity helpers and compatibility resolvers.
3. Update transcript and Git ingestion to share IDs and reference fields.
4. Add valued `produced` fields and indexes.
5. Add realtime ingest telemetry tables and emit events.
6. Build `agentctl dashboard serve` with Ingest Live, Graph Health, Worktrees, and Query Workbench.
7. Add self-improve signal derivation and guidance records.
8. Add dashboard Self-Improve view and agent-facing JSON commands.

## Non-Goals

Do not build an autonomous instruction rewriter in the first pass. Recommendations should be inspectable and reversible.

Do not replace the existing CLI reports immediately. Keep them and route both CLI and dashboard through shared query adapters.

Do not perform a destructive one-shot graph migration without first exposing health checks and compatibility lookups.

Do not add semantic embeddings or ranking before the ID and edge model is stable.

## Open Decisions

The first implementation plan should choose exact SurrealDB index definitions after checking the current schema and the installed SurrealDB version.

The dashboard can start with server-rendered static assets plus browser JavaScript. A React build step is optional only if the UI complexity justifies it.

The first self-improve guidance application target should be conservative: a generated report or agent-facing JSON command before editing durable instruction files automatically.
