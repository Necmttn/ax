# Cognitive-layer dispatch enforcement - one model-tier source of truth

Date: 2026-06-15
Status: final design, pre-implementation
Follows: `docs/superpowers/specs/2026-06-15-dispatch-economy-enforcement-design.md`
(the advisory-hook pivot), `skills/efficient-dispatch/SKILL.md`, the route-dispatch
hook, `ax dispatches`.

## The one thing to internalize

Claude Code hooks **cannot** enforce/rewrite/block the `Agent` (subagent
dispatch) tool - only advise via `additionalContext` (CC bugs #39814 / #40580 /
#24327 / #34692; memory `hooks-cannot-enforce-agent-dispatch`). The just-shipped
route-dispatch hook is therefore **advisory only**. The real lever for "the right
model on the right dispatch" lives in the **cognitive layer**: the orchestrating
agent's standing discipline (the `efficient-dispatch` skill) and the code paths
that classify dispatches. This design hardens that layer and removes a drift bug
between the hook and the measurement lens.

## Problem

Three places independently decide "what model tier does this dispatch want," and
they disagree:

1. **Hook** (`packages/hooks-sdk/src/hooks/route-dispatch.ts:84-86`) computes
   `match` (via `matchRoutingTable`) + `judgmentStrong` (via `JUDGMENT_STRONG_RE`)
   inline, judgment-first (`decideVerdict` rule 0 - judgment is never routed down).
2. **Candidates** (`apps/axctl/src/queries/dispatch-analytics.ts:707`) resolves
   `suggested_model` straight from `routingMatch.suggest` with **no judgment
   carve-out**. A judgment task that also matches a route-down class (regex drift,
   e.g. an `^implement ` description that is really a review) is suggested *down*
   to sonnet and **counted as addressable overspend**.
3. The two therefore **disagree on the judgment∩match cell**: the hook keeps it
   strong, candidates wants it cheap.

Plus: the **skill** frames the split as *main-model vs subagent*, not the
directional rule that actually matters - *implementer subagent → sonnet,
reviewer/judgment subagent → strong*. This session's dispatch economy inverted
exactly that (implementers ran expensive, reviewers cheap; ~$130 over; memory
`feedback-review-gets-strong-model`). The skill never states the direction
front-and-center, so the orchestrating agent has nothing unambiguous to follow.

## Goal

Make implementer→sonnet / reviewer→strong the **explicit, single-sourced** rule
across:
- the **skill** (standing discipline the orchestrating agent follows),
- a pure **helper** (one classifier all code calls),
- the **candidates** lens (honest measurement),
reconciled with the advisory hook.

## Components

### A. `resolveDispatchModel` helper (hooks-sdk, pure)

New file `packages/hooks-sdk/src/resolve-dispatch-model.ts`. Pure, plain TS (no
Effect, no `@ax/lib`) so it is importable by both the hooks-sdk hot path and
axctl - matching the `spend-mode.ts` / `matchRoutingTable` precedent.

```ts
export interface DispatchModelResolution {
  readonly tier: "judgment" | "route-down" | "inherit";
  readonly match: RoutingMatch | null;   // raw match, for classId/reason
  readonly judgmentStrong: boolean;
  readonly effectiveModel: string | null; // route-down → match.suggest;
                                           // judgment | inherit → null (keep strong)
  readonly reason: string;
}

export const resolveDispatchModel = (
  table: RoutingTableShape,
  description: string | null | undefined,
  agentType: string | null | undefined,
): DispatchModelResolution
```

Logic (judgment-first, mirrors `decideVerdict` rule 0):
1. `judgmentStrong = description != null && JUDGMENT_STRONG_RE.test(description)`
   - **reuse the existing narrow `JUDGMENT_STRONG_RE`** from `spend-mode.ts` (one
     regex for hook + helper + candidates; deliberately excludes bare/`spec`
     review, which is a route-down class). No new regex - that would reintroduce
     the drift this work removes.
2. `match = matchRoutingTable(table, description, agentType)`.
3. If `judgmentStrong` → `{ tier: "judgment", effectiveModel: null, ... }`
   (keep strong even when `match !== null`).
4. else if `match` → `{ tier: "route-down", effectiveModel: match.suggest, ... }`.
5. else → `{ tier: "inherit", effectiveModel: null, ... }`.

`effectiveModel: null` means "do not route down - keep the strong/inherited
model." Exhaustively unit-tested (judgment-only, match-only, judgment∩match,
neither, null/empty description, agent-type match).

### B. Wire the consumers (no behavior change except the bugfix)

1. **Hook** (`route-dispatch.ts`): derive `match` / `judgmentStrong` / `suggest`
   from `resolveDispatchModel` instead of computing them inline. `decideVerdict`
   is unchanged (still takes booleans). Net hook behavior **identical** - proven
   by the existing decide-verdict tests + `ax hooks backtest`.
2. **Candidates** (`dispatch-analytics.ts`): call `resolveDispatchModel`;
   **skip rows where `tier === "judgment"`** so judgment∩match dispatches are
   never listed as candidates and never counted in addressable overspend. Use
   `effectiveModel` for `suggested_model`. This is the measurable bugfix:
   candidates stop suggesting that review/design/audit be routed down, and the
   headline `--economy` savings drops to the honest figure (judgment work was
   never actually addressable).
3. `decideVerdict` stays as-is.

### C. Skill hardening (`skills/efficient-dispatch/SKILL.md`)

Rewrite "The split" so the **directional, subagent-tier rule** is front-and-center:

> **Implementer subagents** (well-specified plan tasks, mechanical work) →
> `model: sonnet`.
> **Reviewer / judgment subagents** (quality / PR / final / adversarial / code
> review, design, audit, architect, critique, judge) → **keep the strong model**
> (inherit the main model, or set `model: opus`/`fable` explicitly).

Cite the inversion as the *why* (memory `feedback-review-gets-strong-model`: this
session ran it backwards - implementers expensive, reviewers cheap - ~$130 over,
weaker catch rate). Keep the advisory-hook framing (already correct in dispatch
discipline step 3). Add the **workflow-author note**: sandboxed
`.claude/workflows/*.js` scripts cannot import ax code - set `model:` per
`ax routing show`, and **judgment stages keep the strong model** (the existing
`routing-tune.workflow.js` is the reference: mechanical stages set
`model: "sonnet"`).

### D. Verify

- Exhaustive unit tests on `resolveDispatchModel`.
- `bun test` on touched packages (hooks-sdk + axctl), `bun run typecheck`.
- `ax hooks backtest ~/.ax/hooks/route-dispatch.ts --days=7` - confirm hook
  verdicts unchanged after the rewire.
- **Live `ax dispatches --economy` before/after** - capture the candidates-number
  change (judgment∩match rows leaving the addressable set) as PR evidence.

## What this is NOT

- Not enforcement - hooks can't enforce Agent dispatch (settled). The lever is
  skill discipline + the shared classifier.
- Not a controlled dispatch helper for workflow scripts - they run sandboxed
  (no imports). They get the table via `ax routing show`; the helper serves
  in-tree Effect/axctl code (and unifies the hook + candidates today).
- Not a new regex - reuses `JUDGMENT_STRONG_RE`.

## Honest framing of the win

Component B's candidates fix is the only **same-session** measurable change
(judgment work stops inflating addressable overspend). The skill (Component C)
moves the real number - the inherit/inversion rate - via **adoption over future
sessions**, not instantly. The `--economy` lens is the feedback loop to confirm
it over time.

## Module map

```
packages/hooks-sdk/src/resolve-dispatch-model.ts        NEW: resolveDispatchModel (pure) + tests
packages/hooks-sdk/src/hooks/route-dispatch.ts          rewire to use the helper (behavior identical)
packages/hooks-sdk/src/index.ts                         export resolveDispatchModel + types
apps/axctl/src/queries/dispatch-analytics.ts            candidates: use helper, exclude tier==="judgment"
skills/efficient-dispatch/SKILL.md                      "The split" directional rewrite + workflow-author note
```

## Out of scope (later)

- A real ax dispatch path (none exists today - the helper is forward-compatible
  for when one does).
- `ax routing tune` agent_type mining.
- MCP `dojo_agenda` + other deferred dojo follow-ups (Task 2 in the handoff).
