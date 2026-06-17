---
name: ship-checklist
description: Definition-of-done checklist for shipping a new write, signal, table, edge, or query to the ax graph. Use when adding a SurrealDB table/edge/field, an ingest derive-stage, a new analytic query, or any new ax capability - before opening the PR. Ensures every write gets an on-demand read AND a proactive (agent-facing) read AND docs/distribution, not just the write. Triggers on "ship", "new signal", "new table/edge", "new lens/query", "wire this up", "is this done", or finishing an ax feature branch.
---

# ship-checklist - every write needs a read path an agent can find

The recurring miss in ax: we ship the **write + an on-demand CLI read**, and skip
the **proactive / agent-facing read**. A signal only visible on a manual CLI run
is invisible to the self-improvement loop. ax's whole thesis is that agents
discover and act on signals - so a new write is not done until an agent can find
it without being told.

Organizing rule: **every write needs (B) an on-demand read AND (C) a proactive
read AND an agent-facing surface (MCP/skill).** Most features do A+B and stop.

Run this before opening the PR. Skipping a row is fine - but say so in the PR and
why, don't skip silently.

## A. Write
- [ ] Schema in `schema.surql` + registered in `SCHEMA_TABLES` (CI mirror guard)
- [ ] Ingest idempotent + incremental (since-aware) + deref-free denormalization for reads (no record derefs inside aggregates - they hang prod)
- [ ] Backfill: does history get the signal, or only new data? Note "dark until re-ingest" if so
- [ ] Stage `deps` = every producer of the input table

## B. Read - on-demand
- [ ] CLI: a command or a facet on an existing one (consistent family)
- [ ] `--json` envelope for scripting
- [ ] Dashboard/studio surface (if visual)

## C. Read - proactive (the usually-missed half)
- [ ] **MCP tool** so an agent can query it in-context (`apps/axctl/src/mcp/tools.ts`)
- [ ] `ax improve recommend` generator - mint a proposal when the signal crosses a threshold (agent gets the suggestion unprompted)
- [ ] `ax insights` / dashboard next-actions wiring (if it implies an action)
- [ ] dojo agenda item (if the overnight loop should act on it)
- [ ] **Skill**: a cognitive pattern teaching an agent to *act* on the signal (e.g. the `ln` skill routes visual judgment to subagents off `ax cost images`)

## D. Documentation
- [ ] `CLAUDE.md` command/section docs (there is a docs gate for new subcommands)
- [ ] llms.txt / site docs / README, if user-facing
- [ ] CHANGELOG + release notes (release-please)
- [ ] Spec in `docs/superpowers/specs/` for non-trivial features

## E. Onboarding / distribution
- [ ] Onboarding prompt (`@ax/onboarding-prompt`) - should a day-1 user/agent know it exists?
- [ ] Marketing coverage (site page / blog / X), if a user-facing capability
- [ ] `/api/version` capability flag, if relevant

## F. Verify (evidence, not assertion)
- [ ] Tests: unit on pure helpers + schema-mirror guard + CLI command-list test
- [ ] Live-verified against the real DB - paste the actual output in the PR
- [ ] "Dark until data" honesty: state if it needs backfill/telemetry to light up

## How to use

Create a TodoWrite item per relevant row, or paste the A-F headers into the PR
body as a checked list. The point is the **C section** - if a new signal has no
MCP tool, no improve generator, and no skill, an agent will never surface it on
its own, and the feature is half-built no matter how clean the write is.
