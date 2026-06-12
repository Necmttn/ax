# Improve-first dashboard - design spec

**Date:** 2026-06-12
**Status:** approved-pending-review
**Driver feedback:** "dashboard should show me what to do next - takeaways, what should I work on, copy-to-clipboard action items to give to my agent. Focus on improve, remove unnecessary bits, polish improve, embed decisions into it."

## Goal

Invert the dashboard: today it is ~17 sibling routes with the Improve tab as bare
CRUD. After this work it is a focused product - **Wrapped** as the landing recap,
**Improve** as the work surface that answers "what should I work on next" with
copy-pasteable agent briefs, and a short nav of surfaces that earn their slot.

## Final state

### Navigation

Top-level nav: **Wrapped (`/`, landing) · Improve · Sessions · Skills · Workflow**.

Footer **Lab** link → hidden power-user area: Canvas, Graph explorer (6 modes),
SQL console. No "More" dropdown.

Contextual-only routes (kept, no nav entry):

| Route | Entry point |
|---|---|
| `/projects/$slug` | click project name in Sessions |
| `/tools` (tool failures) | click-through from Next Actions cards |
| `/sessions/compare` | multi-select checkboxes in Sessions list → "Compare" |
| `/skills/graph` | tab/toggle inside Skills route |

Removed routes:

- `/recall` - humans don't search here; API + MCP tool stay (AI surface).
- `/decisions` - folds into Improve (zone 3 below).
- `/ingest-live` - becomes the ingest splash overlay (below).
- `/canvas` nav entry - route moves under Lab.

### Improve route - three zones

**Zone 1: Next Actions panel** (top, the headline feature).

New endpoint `/api/next-actions` aggregates existing queries into ranked action
cards:

| Source | Card example |
|---|---|
| Open proposals (rank: confidence × frequency) | "Accept/reject: <title>" |
| Pending verdicts (accepted experiments w/o locked verdict) | "Lock verdict on <exp>, suggested: adopted" |
| Tool failures with `recommendation=fix` | "Fix `bun test` exit-127 cluster - 14 fails / 6 sessions" |
| Churn outliers (`sessions churn` data) | "Session X: 3.2× repair LOC vs baseline" |
| Routing candidates (`dispatches --candidates`) | "Route task-N-impl → sonnet, est $4.10/mo" |
| Skill hygiene (unclassified ≥3-invocation skills, pending triage) | "Classify `composto` - 41 invocations, no role" |

Card anatomy: title · one-line evidence · impact rank · **Copy agent brief**
button · inline one-click action (accept / reject / verdict / decide) where the
action is decidable in place · drill-down link to the detail route.

**Agent briefs are generated server-side** and shipped in the payload as a
markdown string per card. Frontend only does `navigator.clipboard.writeText`.
Brief format:

```markdown
## Task: <imperative title>

**Evidence:** <counts, session ids, sigs, $ amounts>

**Ask:** <concrete change>

**Verify:** <ax command + expected movement>

_source: ax <kind> sig=<dedupe_sig>_
```

Server-side generation keeps briefs reusable by a future `ax next` CLI command
(out of scope this round).

**Zone 2: Proposals** - existing table + detail pane, polished:

- `origin` badge (mined vs agent - see write-path below)
- rank by confidence × frequency
- Copy-brief button on every proposal
- agent-origin proposals rank above mined ones at equal confidence

**Zone 3: Decisions** - the old `/decisions` content (skill triage decisions +
verdict history) embedded as a collapsible section.

### Live = ingest splash, not a route

On app load the frontend checks ingest state. If the daemon is ingesting (or
landing triggers a fresh `--since=1` ingest), show a **loading overlay**
streaming live trace events from the existing Durable Stream wiring
(`IngestStreamBus`, SSE at `/api/events`) - "parsing 14 transcripts… 2,300
turns" - then dissolve into the app. This restores the original intent that got
lost in translation as a standalone route.

Compiled-binary fallback (no live ingest): poll count tiles via the existing
`apps/studio/src/poll-fallback.ts` path; never show a dead overlay.

### Agent-driven deep analysis (write-path)

Mechanical signals stay; deeper signals come from an agent session. Mirrors the
`ax skills classify` brief pattern:

- **`ax improve analyze`** - emits `.ax/tasks/analyze-improve-<date>.md`:
  instructs an agent to mine ax data (sessions churn, recall, dispatches, tool
  failures, MCP read tools) and write back richer proposals with evidence refs.
- **`ax improve propose`** - agent write-path: JSON on stdin → inserts a
  proposal (any form) with dedupe sig and `origin: "agent"`.
- `proposal` table gains an `origin` field (`"mined" | "agent"`, default
  `"mined"`). Additive schema change - safe per orphan-field rules.
- Dashboard: **"Run deep analysis"** button on Improve copies the analyze brief
  to clipboard (works against hosted studio; no daemon write needed).

Rejected alternatives: MCP mutating tool (MCP is read-only by design); server
forking `claude -p` (heavy, auth, surprises).

### Wrapped remake (landing)

Paxel-style card grid (YC reference): each card = **eyebrow question → big
headline → 2-line body** + dithered halftone art. Headlines carry the card;
copy is personality-led, not mechanical template strings.

- **`ax wrapped generate`** - emits an agent brief; agent mines ax data
  (sessions, prompts, models, corrections, streaks) and writes punchy cards
  ("You steer, hard", "4h 12m") via:
- **`ax wrapped publish`** - JSON stdin → new `wrapped_card` table (question,
  headline, body, sensitivity, generated_at, origin). Register in
  `SCHEMA_TABLES` (insights.ts) - guarded by test, fails CI if missed.
- `/api/wrapped` serves agent cards when present; falls back to current
  mechanical facts. Sensitivity flags kept for `public-preview` redaction.
- Dashboard "Regenerate wrapped" button → copies brief to clipboard (same
  pattern as deep analysis).
- Visual: orange halftone/dither aesthetic, headline-first typography.

### Bug fix: synthetic codex skills polluting skill surfaces

`apps/axctl/src/ingest/codex.ts:669` writes synthetic `codex:<tool>` skill
invocations for every Codex tool call (documented `provider-parity.ts:182`).
These drown real skills on every skill surface (projects top-skills shows
39,545 `codex:exec_command` "invocations") and double-count: the same calls
exist in `tool_call`.

This round: **exclude synthetic provider-tool invocations from skill-facing
surfaces** (projects top-skills, skills weighted, skill triage). Identification:
`codex:` prefix on skill name where the name matches the Codex built-in tool
set. Follow-up issue: stop emitting them as skill invocations at all (needs
tombstone/migration thinking - out of scope).

## Delivery - 4 PRs

1. **Improve core**: `/api/next-actions` + panel + server-side briefs + copy
   buttons + decisions merge + proposal polish + codex-synthetic-skill filter.
2. **Nav + live splash**: re-home, nav shrink, Lab area, recall/live/decisions
   route removal, contextual entries (Sessions multi-select → Compare, Skills
   tab → graph), ingest overlay.
3. **Agent write-path**: `ax improve analyze` + `ax improve propose` + `origin`
   field + agent badge + "Run deep analysis" button.
4. **Wrapped remake**: `wrapped_card` table + `ax wrapped generate/publish` +
   Paxel-style landing + "Regenerate wrapped" button.

Engineering defaults: Effect-native handlers, additions to
`packages/lib/src/shared/dashboard-types.ts` end-to-end typed, bun:test per
query aggregator, consult effect-solutions before Effect code.

## Out of scope / follow-ups

- **Workflow remake** - data is valuable, stays top-level; visual/content
  remake is its own design pass.
- **Compare as cross-harness/model bench** - proactively running the same task
  against multiple harnesses/models and comparing. Hard, high marketing
  potential. Roadmap note only.
- **`ax next` CLI** - reuse server-side briefs in the terminal.
- **Codex synthetic skill emission removal** - ingest change + data migration.
- **Graph explorer harvest** - any Lab mode that earns it graduates into the
  Workflow remake.
