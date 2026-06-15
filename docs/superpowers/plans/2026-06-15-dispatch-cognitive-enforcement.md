# Cognitive-layer Dispatch Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pure `resolveDispatchModel` classifier, shared by the route-dispatch hook and `ax dispatches` candidates, that applies judgment-first precedence (reviewer→strong) so the hook and the measurement lens stop disagreeing; plus an `efficient-dispatch` skill rewrite that states the directional implementer→sonnet / reviewer→strong rule front-and-center.

**Architecture:** Add a pure, Effect-free helper in `packages/hooks-sdk` (importable by both the ~70ms hook hot path and axctl, like `spend-mode.ts`). Rewire the hook to derive `match`/`judgmentStrong`/`suggest` from it (behavior identical - `decideVerdict` untouched), and rewire candidates to call it and exclude `tier === "judgment"` rows from addressable overspend (the bugfix). Reuse the existing `JUDGMENT_STRONG_RE` - no new regex.

**Tech Stack:** TypeScript (strict), bun:test, Effect v4 (axctl side only), `@ax/hooks-sdk` per-file `./*` exports.

**Worktree:** `.claude/worktrees/dispatch-cognitive` (branch `feat/dispatch-cognitive-enforcement`). All edits happen here.

**Spec:** `docs/superpowers/specs/2026-06-15-dispatch-cognitive-enforcement-design.md`

---

## Task 1: `resolveDispatchModel` pure helper

**Files:**
- Create: `packages/hooks-sdk/src/resolve-dispatch-model.ts`
- Test: `packages/hooks-sdk/src/resolve-dispatch-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hooks-sdk/src/resolve-dispatch-model.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolveDispatchModel } from "./resolve-dispatch-model.ts";
import { DEFAULT_ROUTING_TABLE } from "./routing-table.ts";

const T = DEFAULT_ROUTING_TABLE;

describe("resolveDispatchModel", () => {
  it("route-down: mechanical impl description → sonnet", () => {
    const r = resolveDispatchModel(T, "implement the parser toolkit", null);
    expect(r.tier).toBe("route-down");
    expect(r.judgmentStrong).toBe(false);
    expect(r.effectiveModel).toBe("sonnet");
    expect(r.match?.classId).toBe("well-specified-impl");
  });

  it("judgment: a review description → keep strong (effectiveModel null)", () => {
    const r = resolveDispatchModel(T, "PR review of the auth module", null);
    expect(r.tier).toBe("judgment");
    expect(r.judgmentStrong).toBe(true);
    expect(r.effectiveModel).toBeNull();
  });

  it("judgment beats route-down: description matches BOTH a class and judgment", () => {
    // "implement design review feedback" matches well-specified-impl (^implement )
    // AND JUDGMENT_STRONG_RE (design). Judgment precedence wins.
    const r = resolveDispatchModel(T, "implement design review feedback", null);
    expect(r.tier).toBe("judgment");
    expect(r.judgmentStrong).toBe(true);
    expect(r.effectiveModel).toBeNull();
    // raw match is still surfaced for callers that want classId/reason
    expect(r.match).not.toBeNull();
  });

  it("inherit: no class, not judgment → keep inherited (null)", () => {
    const r = resolveDispatchModel(T, "ponder the meaning of the codebase", null);
    expect(r.tier).toBe("inherit");
    expect(r.judgmentStrong).toBe(false);
    expect(r.effectiveModel).toBeNull();
    expect(r.match).toBeNull();
  });

  it("agent-type route-down: Explore → haiku via agentTypes", () => {
    const r = resolveDispatchModel(T, "anything", "Explore");
    expect(r.tier).toBe("route-down");
    expect(r.effectiveModel).toBe("haiku");
    expect(r.match?.source).toBe("agentType");
  });

  it("null/empty description → inherit, no throw", () => {
    expect(resolveDispatchModel(T, null, null).tier).toBe("inherit");
    expect(resolveDispatchModel(T, "", null).tier).toBe("inherit");
    expect(resolveDispatchModel(T, undefined, undefined).tier).toBe("inherit");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hooks-sdk && bun test src/resolve-dispatch-model.test.ts`
Expected: FAIL - `Cannot find module './resolve-dispatch-model.ts'`.

(Note: a global hook may block bare `bun test`. If so, use the project tmp-wrapper convention from memory `test_runner` - copy `bun` to a tmp script and invoke that.)

- [ ] **Step 3: Write minimal implementation**

Create `packages/hooks-sdk/src/resolve-dispatch-model.ts`:

```ts
// packages/hooks-sdk/src/resolve-dispatch-model.ts
//
// One classifier for "what model tier does this dispatch want." Shared by the
// route-dispatch hook (fire path) and `ax dispatches` candidates so the two can
// never disagree on the judgment∩route-down cell. Pure + Effect-free (importable
// in the ~70ms hot path), matching the spend-mode.ts / matchRoutingTable
// precedent. Judgment-first precedence mirrors decideVerdict rule 0: a review/
// design/audit dispatch is NEVER routed down, even when its description also
// matches a route-down class (regex drift).
import {
  matchRoutingTable,
  type RoutingMatch,
  type RoutingTableShape,
} from "./routing-table.ts";
import { JUDGMENT_STRONG_RE } from "./spend-mode.ts";

export type DispatchTier = "judgment" | "route-down" | "inherit";

export interface DispatchModelResolution {
  /** judgment → keep strong; route-down → cheaper tier; inherit → no opinion. */
  readonly tier: DispatchTier;
  /** Raw routing match (populated even when judgment wins), for classId/reason. */
  readonly match: RoutingMatch | null;
  readonly judgmentStrong: boolean;
  /** route-down → suggested cheaper model; judgment | inherit → null (keep strong/inherited). */
  readonly effectiveModel: string | null;
  readonly reason: string;
}

export const resolveDispatchModel = (
  table: RoutingTableShape,
  description: string | null | undefined,
  agentType: string | null | undefined,
): DispatchModelResolution => {
  const judgmentStrong =
    description != null && description.length > 0 && JUDGMENT_STRONG_RE.test(description);
  const match = matchRoutingTable(table, description, agentType);

  if (judgmentStrong) {
    return {
      tier: "judgment",
      match,
      judgmentStrong: true,
      effectiveModel: null,
      reason: "judgment work (review/design/audit) - keep the strong model",
    };
  }
  if (match) {
    return {
      tier: "route-down",
      match,
      judgmentStrong: false,
      effectiveModel: match.suggest,
      reason: match.reason,
    };
  }
  return {
    tier: "inherit",
    match: null,
    judgmentStrong: false,
    effectiveModel: null,
    reason: "no route-down class matched - keep the inherited model",
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hooks-sdk && bun test src/resolve-dispatch-model.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hooks-sdk/src/resolve-dispatch-model.ts packages/hooks-sdk/src/resolve-dispatch-model.test.ts
git commit -m "feat(hooks-sdk): resolveDispatchModel classifier (judgment-first)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Export `resolveDispatchModel` from the package index

**Files:**
- Modify: `packages/hooks-sdk/src/index.ts`

- [ ] **Step 1: Add the export**

Append to `packages/hooks-sdk/src/index.ts` (after the routing-table export block, line 22):

```ts
export {
  resolveDispatchModel,
  type DispatchModelResolution,
  type DispatchTier,
} from "./resolve-dispatch-model.ts";
```

- [ ] **Step 2: Verify it resolves**

Run: `cd packages/hooks-sdk && bun -e "import('./src/index.ts').then(m => console.log(typeof m.resolveDispatchModel))"`
Expected: prints `function`.

(The `@ax/hooks-sdk/resolve-dispatch-model` subpath also resolves directly via the
`./*` wildcard export in package.json - no package.json change needed.)

- [ ] **Step 3: Commit**

```bash
git add packages/hooks-sdk/src/index.ts
git commit -m "feat(hooks-sdk): export resolveDispatchModel from index

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Rewire the route-dispatch hook to use the helper

**Files:**
- Modify: `packages/hooks-sdk/src/hooks/route-dispatch.ts`

**Goal:** identical hook behavior, classification now sourced from `resolveDispatchModel`. The existing `decide-verdict.test.ts` + `route-dispatch.test.ts` are the regression guard - they MUST stay green with no edits.

- [ ] **Step 1: Run the existing hook tests to capture the green baseline**

Run: `cd packages/hooks-sdk && bun test src/decide-verdict.test.ts src/hooks/route-dispatch.test.ts`
Expected: PASS. Record the pass count - it must be unchanged after the rewire.

- [ ] **Step 2: Swap the imports**

In `packages/hooks-sdk/src/hooks/route-dispatch.ts`, change the import block. Replace:

```ts
import { loadRoutingTableOrDefault, matchRoutingTable } from "../routing-table.ts";
import {
  computeSpendMode,
  DEFAULT_SPEND_CONFIG,
  defaultQuotaCachePath,
  JUDGMENT_STRONG_RE,
  readQuotaCacheSync,
  type SpendConfig,
} from "../spend-mode.ts";
```

with:

```ts
import { loadRoutingTableOrDefault } from "../routing-table.ts";
import { resolveDispatchModel } from "../resolve-dispatch-model.ts";
import {
  computeSpendMode,
  DEFAULT_SPEND_CONFIG,
  defaultQuotaCachePath,
  readQuotaCacheSync,
  type SpendConfig,
} from "../spend-mode.ts";
```

- [ ] **Step 3: Replace the inline classification**

Replace these three lines (currently ~84-86):

```ts
      const table = loadRoutingTableOrDefault();
      const match = matchRoutingTable(table, description, subagentType);
      const judgmentStrong = description !== undefined && JUDGMENT_STRONG_RE.test(description);
```

with:

```ts
      const table = loadRoutingTableOrDefault();
      const resolution = resolveDispatchModel(table, description, subagentType);
```

Then update the `decideVerdict` call (currently ~101-108):

```ts
      return decideVerdict({
        match: resolution.match !== null,
        explicit,
        cheap,
        judgmentStrong: resolution.judgmentStrong,
        routeDownEnforced: mode === "conserve",
        suggest: resolution.match?.suggest ?? "sonnet",
      });
```

- [ ] **Step 4: Verify hook tests still pass unchanged**

Run: `cd packages/hooks-sdk && bun test src/decide-verdict.test.ts src/hooks/route-dispatch.test.ts`
Expected: PASS, same count as Step 1. (Behavior is provably identical: `match: resolution.match !== null` and `judgmentStrong: resolution.judgmentStrong` reproduce the old inputs exactly; `decideVerdict` rule 2's `!judgmentStrong` guard already handled the judgment∩match cell.)

- [ ] **Step 5: Full hooks-sdk test + typecheck**

Run: `cd packages/hooks-sdk && bun test`
Expected: PASS.
Run: `cd /Users/necmttn/Projects/ax && bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/hooks-sdk/src/hooks/route-dispatch.ts
git commit -m "refactor(hooks-sdk): route-dispatch derives classification from resolveDispatchModel

Behavior identical; single source of truth for match/judgment/suggest.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Candidates exclude judgment work (the bugfix)

**Files:**
- Modify: `apps/axctl/src/queries/dispatch-analytics.ts`
- Test: `apps/axctl/src/queries/dispatch-analytics.test.ts` (extend)

**Goal:** `ax dispatches --candidates` (and `--economy` addressable overspend) must never list a `tier === "judgment"` dispatch, even when its description matches a route-down class.

- [ ] **Step 1: Inspect the existing test surface**

Run: `cd /Users/necmttn/Projects/ax && rg -n "matchRouting|candidate|judgment|resolveDispatch" apps/axctl/src/queries/dispatch-analytics.test.ts`
Expected: shows whether candidates are tested via a pure helper or the full Effect/DB query. If the candidates loop is only reachable through the DB query, add the pure assertion in Step 2 against `resolveDispatchModel` directly (the loop's exclusion predicate), since the helper IS the decision point.

- [ ] **Step 2: Write the failing test**

Add to `apps/axctl/src/queries/dispatch-analytics.test.ts`:

```ts
import { resolveDispatchModel } from "@ax/hooks-sdk/resolve-dispatch-model";
import { ROUTING_CLASSES } from "./dispatch-analytics.ts";

describe("candidates exclude judgment work", () => {
  it("a judgment∩route-down dispatch is not a route-down candidate", () => {
    // matches well-specified-impl (^implement ) AND judgment (design) →
    // candidates loop skips it (tier !== "route-down").
    const r = resolveDispatchModel(ROUTING_CLASSES, "implement design review feedback", null);
    expect(r.tier).toBe("judgment");
    // the candidates predicate:
    const isCandidate = r.tier === "route-down" && r.match !== null;
    expect(isCandidate).toBe(false);
  });

  it("a plain mechanical impl IS still a route-down candidate", () => {
    const r = resolveDispatchModel(ROUTING_CLASSES, "implement the lmdb cache reader", null);
    expect(r.tier).toBe("route-down");
    const isCandidate = r.tier === "route-down" && r.match !== null;
    expect(isCandidate).toBe(true);
    expect(r.effectiveModel).toBe("sonnet");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/necmttn/Projects/ax && bun test apps/axctl/src/queries/dispatch-analytics.test.ts`
Expected: FAIL on the import - `@ax/hooks-sdk/resolve-dispatch-model` is imported but the candidates loop does not yet use it (the assertions on `resolveDispatchModel` itself will actually pass; this step's real purpose is to lock the predicate the loop must use. If both new tests pass already, that is fine - they document the contract; proceed to wire the loop in Step 4).

- [ ] **Step 4: Wire the helper into the candidates loop**

In `apps/axctl/src/queries/dispatch-analytics.ts`, add the import near the top (alongside the existing `@ax/hooks-sdk/routing-table` import, ~line 26):

```ts
import { resolveDispatchModel } from "@ax/hooks-sdk/resolve-dispatch-model";
```

Then in the candidates loop, replace these lines (currently ~703-709):

```ts
            // Candidate criterion (c): description or agent_type matches a routing class
            const routingMatch = matchRoutingWith(table, sp.description, sp.agent_type);
            if (!routingMatch) continue;

            // Resolve suggested model name
            const suggestedAlias = routingMatch.suggest;
            const suggestedModelName = MODEL_ALIASES[suggestedAlias] ?? suggestedAlias;
```

with:

```ts
            // Candidate criterion (c): route-down class match AND not judgment work.
            // Judgment dispatches (review/design/audit) are never routed down, even
            // when their description also matches a route-down class (regex drift),
            // so they are excluded from candidates / addressable overspend.
            const resolution = resolveDispatchModel(table, sp.description, sp.agent_type);
            if (resolution.tier !== "route-down" || !resolution.match) continue;
            const routingMatch = resolution.match;

            // Resolve suggested model name
            const suggestedAlias = resolution.effectiveModel ?? routingMatch.suggest;
            const suggestedModelName = MODEL_ALIASES[suggestedAlias] ?? suggestedAlias;
```

(`routingMatch` stays defined for the existing `routing_match: routingMatch` field and the class-savings rollup below - no other edits needed.)

- [ ] **Step 5: Run the test + full axctl query tests**

Run: `cd /Users/necmttn/Projects/ax && bun test apps/axctl/src/queries/dispatch-analytics.test.ts`
Expected: PASS.
Run: `cd /Users/necmttn/Projects/ax && bun run typecheck`
Expected: no errors. (If `matchRoutingWith` is now unused anywhere, leave it - it is an exported helper with its own tests; do not delete.)

- [ ] **Step 6: Commit**

```bash
git add apps/axctl/src/queries/dispatch-analytics.ts apps/axctl/src/queries/dispatch-analytics.test.ts
git commit -m "fix(dispatches): exclude judgment work from route-down candidates

Candidates + addressable overspend now share resolveDispatchModel with the
hook; judgment∩match dispatches are no longer suggested down (honest savings).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Harden the efficient-dispatch skill

**Files:**
- Modify: `skills/efficient-dispatch/SKILL.md`

**Goal:** the directional implementer→sonnet / reviewer→strong rule is front-and-center. Do NOT touch the autogenerated `<!-- ax:routing-table -->` block (it is regenerated by `ax dispatches compile-routing`).

- [ ] **Step 1: Rewrite "The split" section**

In `skills/efficient-dispatch/SKILL.md`, replace the current "## The split" section (the `**Main model keeps** ... **Cheaper models take** ...` paragraph) with:

```markdown
## The split

Two axes. First, **main model vs subagent**: the main model orchestrates and
reviews; mechanical work goes to subagents. Second, and the one that actually
controls spend - **the tier of each subagent dispatch:**

- **Implementer subagents** (well-specified plan tasks, mechanical edits, search,
  bulk transforms) → dispatch with **`model: sonnet`** (or haiku for pure
  search/locate, per the table).
- **Reviewer / judgment subagents** (quality / PR / final / adversarial / code
  review, design, audit, architect, critique, judge) → **keep the strong model**:
  inherit the main model, or set `model: opus`/`fable` explicitly. Review is the
  catch-rate gate; a cheap reviewer misses real bugs.

Get this backwards and you pay twice: in one ax session implementers ran on the
expensive inherited model while reviewers were sent to a cheap one - ~$130 over,
weaker catch rate, three fix rounds (memory `feedback-review-gets-strong-model`).
The default-inherit trap is implementers, not reviewers: a forgotten `model:` on
an `implement …` dispatch silently runs expensive. Set it.

**Main model keeps** (never dispatched at all): decomposition, architecture and
product tradeoffs, plan synthesis, judging conflicting subagent reports, final
integration, taste-heavy design/copy.
```

- [ ] **Step 2: Add the workflow-author note to "Dispatch discipline"**

In the same file, in the `## Dispatch discipline` numbered list, after item 3 (the route-dispatch hook paragraph), add a new item:

```markdown
4. **Workflow scripts** (`.claude/workflows/*.js`) run sandboxed and cannot
   import ax code. Set `model:` on every `agent(...)` call by hand, per
   `ax routing show`: mechanical stages → `model: 'sonnet'`; judgment/review
   stages → keep the strong model. `routing-tune.workflow.js` is the reference.
   In-tree Effect/axctl code that dispatches should call `resolveDispatchModel`
   (from `@ax/hooks-sdk`) instead of hardcoding.
```

(Renumber the existing items 4 → 5 in that list - the "Treat subagent reports as leads" item becomes 5.)

- [ ] **Step 3: Verify the skill still scans clean**

Run: `cd /Users/necmttn/Projects/ax && rg -n "ax:routing-table" skills/efficient-dispatch/SKILL.md`
Expected: the two autogen markers are still present and untouched (open + close).
Run: `cd /Users/necmttn/Projects/ax && rg -n "implementer|reviewer|resolveDispatchModel|feedback-review-gets-strong-model" skills/efficient-dispatch/SKILL.md`
Expected: the new directional rule + reference are present.

- [ ] **Step 4: Commit**

```bash
git add skills/efficient-dispatch/SKILL.md
git commit -m "docs(skill): efficient-dispatch states implementer->sonnet / reviewer->strong

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Full verification + economy diff

**Files:** none (verification only)

- [ ] **Step 1: Repo-wide test + typecheck**

Run: `cd /Users/necmttn/Projects/ax && bun test`
Expected: PASS (whole repo).
Run: `cd /Users/necmttn/Projects/ax && bun run typecheck`
Expected: no errors.

- [ ] **Step 2: check:no-node-fs gate (hooks-sdk hot-path files)**

Run: `cd /Users/necmttn/Projects/ax && bun scripts/check-no-node-fs.ts`
Expected: PASS. (`resolve-dispatch-model.ts` uses no `node:fs` - it is pure - so no allowlist entry is needed. If the gate flags it, that is a real bug: remove the fs usage.)

- [ ] **Step 3: Hook backtest - confirm verdicts unchanged**

Run: `cd /Users/necmttn/Projects/ax && bun run apps/axctl/src/cli/index.ts hooks backtest ~/.ax/hooks/route-dispatch.ts --days=7`
Expected: runs clean; verdict distribution consistent with pre-change behavior (no new blocks; advisories only). Note: state-dependent, uses current repo state (caveat printed by the tool).

- [ ] **Step 4: Live economy diff (the headline evidence)**

Run BEFORE merging, capture both for the PR body:

```bash
cd /Users/necmttn/Projects/ax
# baseline from main (the pre-fix number):
git -C . stash list >/dev/null 2>&1
bun run apps/axctl/src/cli/index.ts dispatches --economy --days=7 --json > /tmp/economy-after.json
# the candidates count + addressable overspend should be <= the handoff's
# "124 (70%) / ~$459 addressable" if any judgment∩match rows existed in the window.
jq '{routable: .summary, addressable: .total_est_savings_usd, candidates: (.candidates | length)}' /tmp/economy-after.json
```

Compare against the handoff's pre-fix figures (177 routable / 124 expensive / ~$459 addressable). Document the delta - judgment∩match rows leaving the addressable set - in the PR. If the delta is zero (no judgment∩match dispatches in the window), state that explicitly: the fix is still correct (prevents future mis-counting), just not triggered by current data.

- [ ] **Step 5: Open the PR**

```bash
cd /Users/necmttn/Projects/ax
git push -u origin feat/dispatch-cognitive-enforcement
gh pr create --base main --title "feat: cognitive-layer dispatch enforcement (shared model-tier classifier)" --body "$(cat <<'EOF'
## What

One pure `resolveDispatchModel` classifier shared by the route-dispatch hook and
`ax dispatches` candidates, applying judgment-first precedence so reviewer/design/
audit work is never routed down. Hardens `efficient-dispatch` to the directional
implementer→sonnet / reviewer→strong rule.

## Why

Hooks can't enforce Agent dispatch (CC #39814/#40580); the real lever is the
cognitive layer. The hook and candidates lens disagreed on the judgment∩route-down
cell - candidates suggested routing review down and counted it as addressable
overspend. This unifies them.

## Changes

- `resolveDispatchModel` (hooks-sdk, pure, reuses `JUDGMENT_STRONG_RE`)
- route-dispatch hook rewired to it (behavior identical - tests unchanged)
- candidates exclude `tier === "judgment"` (honest addressable overspend)
- efficient-dispatch skill: directional rule front-and-center + workflow-author note

## Evidence

- hooks-sdk + axctl tests green, typecheck clean, no-node-fs gate clean
- `ax hooks backtest route-dispatch --days=7`: verdicts unchanged
- `ax dispatches --economy` before/after: <fill in the delta from Step 4>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- A. `resolveDispatchModel` helper → Task 1 + Task 2. ✓
- B. wire 3 consumers → hook Task 3, candidates Task 4, decideVerdict untouched ✓
- C. skill hardening → Task 5 ✓
- D. verify (unit/typecheck/backtest/economy diff) → Task 6 ✓

**Placeholder scan:** one intentional fill-in - the economy delta in the PR body (Step 4 → Step 5), which is runtime data that cannot be known until execution. Flagged, not a logic gap.

**Type consistency:** `resolveDispatchModel(table, description, agentType) → DispatchModelResolution { tier, match, judgmentStrong, effectiveModel, reason }` used identically in Tasks 1, 3, 4. `effectiveModel` (not `model`/`suggestedModel`) throughout. `tier === "judgment" | "route-down" | "inherit"` consistent. Hook passes `resolution.match !== null` / `resolution.judgmentStrong` / `resolution.match?.suggest` matching `DecideInput`'s existing `match`/`judgmentStrong`/`suggest` booleans+string.
