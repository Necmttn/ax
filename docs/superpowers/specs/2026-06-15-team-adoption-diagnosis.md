# ax Team Adoption - Diagnosis & 3-Fix Roadmap

**Date:** 2026-06-15
**Context:** Commercialization of ax to teams blocked on adoption + utilization. The product's value compounds with usage, but every adoption mechanism is pull-based and individual. A team buyer needs the opposite: proof of use, zero-effort value delivery, an aggregate surface.

## Evidence (measured from ax's own graph)

Mined the dogfood funnel: 197,858 `tool_call` rows; `ax ` invocations isolated from Bash `command_text`. This is the **author's own usage** = the adoption ceiling, not a team.

### Finding 1 - ax can't see its own adoption
No self-telemetry. ax measures *agent transcripts*, never *whether ax itself is run*. Only way to see usage was mining Bash tool_calls for `ax `. Sales problem: cannot answer the buyer's first question ("are my devs using it?").

### Finding 2 - surface sprawl, power-law usage
24 subcommands ship; real usage concentrates in ~6.

```
sessions  90   ← the query surface
ingest    36   (mostly auto via watcher)
recall    34
share/improve/skills/retro  ~23 each
serve/hooks  17
dispatches 12 · dojo 11
--- long tail barely touched ---
routing 5 · cost 5 · profile 4 · signals 4 · thinking ~0 · quota ~0 · wrapped ~0
```

Even the author never touches half the product. New team member sees 24 doors, opens 2.

### Finding 3 - value is pull-only, no habit loop
Ingest is passive (watcher auto-runs - good). But all *value* is pull: user must remember to type `ax sessions` / `ax serve`. Nothing brings the user back. Usage is bursty build-days with gaps (e.g. May 9–11 zero, May 13 = 1 call). Even the author has no daily habit; a team member will have zero.

### Finding 4 - single-player product, team buyer has no surface
All value is local + individual. Community rails exist but team-internal rollup (the lead/buyer's view) is weak. The person who pays has nothing to open.

## Root cause

> ax value compounds with usage. Every adoption mechanism is pull-based and individual. The buyer needs proof of use + zero-effort value delivery + an aggregate surface.

## The 3 fixes (build order: 2 → 1 → 3)

### Fix #2 - Push the value, don't wait for pull  *(FIRST - fastest path to habit)*
The watcher already fires on every session. Make it *surface* value instead of silently ingesting. Inject a one-line digest into the agent context (SessionStart hooks already owned), and/or a daily summary. Turns passive ingest into a habit loop.
- Leverage: highest. Fixes Finding 3.
- Asset reuse: SessionStart hooks, watcher, improve-first dashboard data.

### Fix #1 - Self-telemetry + team utilization view  *(SECOND - the literal thing teams pay for)*
ax tracks its own invocations → `ax serve` admin tab: who ingested, who queried, active-days/dev, command mix. This is the artifact you sell.
- Leverage: the sales surface. Fixes Finding 1 + 4.
- New: a self-telemetry capture path (not transcript-derived); an aggregate team view.

### Fix #3 - Collapse the surface  *(THIRD)*
One `ax` no-arg command = "here are your 3 things right now." improve-first dashboard already exists - make it the front door. 24 commands → 1 entry.
- Leverage: discovery + onboarding. Fixes Finding 2.
- Asset reuse: improve-first dashboard / next-actions.

## Status
- [ ] Fix #2 - push value via SessionStart hook + watcher
- [ ] Fix #1 - self-telemetry + team utilization view
- [ ] Fix #3 - collapse surface to one front-door command
