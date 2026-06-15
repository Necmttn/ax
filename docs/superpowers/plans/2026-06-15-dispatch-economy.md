# Quota-aware dispatch economy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make subagent model-routing quota-aware: auto-route forgotten cheap-able dispatches in conserve mode, relax (subtractive) near a 7d reset (splurge), warn when judgment work is sent cheap, keep the quota signal fresh, and nudge `/dojo` in splurge. Per spec `docs/superpowers/specs/2026-06-15-dispatch-economy-enforcement-design.md`.

**Architecture:** A pure `computeSpendMode` + a pure `decideVerdict` in `packages/hooks-sdk` (hot-path, effect-only). The route-dispatch hook gains a new `Verdict.route(input)` (silent `updatedInput` rewrite). Everything keys off one knob: `routeDownEnforced = (mode === "conserve")`. PR1 = the conserve logic (works safely against whatever cache exists; stale/missing → conserve). PR2 = freshness (SessionStart + interval refresh) + the `/dojo` nudge + statusline surface + a measurement lens.

**Tech Stack:** bun ≥1.3, TS strict, Effect v4 beta, bun:test. hooks-sdk is `effect`-only (no @ax/lib in the ~70ms hot path).

**Conventions:** Worktree `/Users/necmttn/Projects/ax/.claude/worktrees/dispatch-economy` (branch `feat/dispatch-economy`). Test = `bun test <path>` (tmp wrapper if a hook blocks bare `bun test`). hooks-sdk uses sync `node:fs` on the fire path (precedent: `readRoutingTableSync`). Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Grounding (verified post-#411):**
- `Verdict` union + constructors: `packages/hooks-sdk/src/verdict.ts` (Allow/Block/Warn/Inject).
- `encodeVerdict(v, harness) → {exitCode:0|2, stdout?, stderr?}`: `packages/hooks-sdk/src/adapters/encode.ts:17`. Warn → `{exitCode:0, stdout: JSON.stringify({systemMessage})}`. Inject → `{exitCode:0, stdout: context}`.
- route-dispatch.ts: `run: (event) => Effect.sync(...)`, reads `event.tool.input` (`model`, `subagent_type`, `description`, `prompt`), calls `matchRoutingTable(loadRoutingTableOrDefault(), description, subagentType)` → `RoutingMatch{classId,suggest,reason,source} | null`.
- `readRoutingTableSync(path?)` sync precedent: `packages/hooks-sdk/src/routing-table.ts:250`. `defaultRoutingTablePath()` = `~/.ax/hooks/routing-table.json`.
- `QuotaSnapshot` (`apps/axctl/src/quota/schema.ts:48`): `{ v:1, fetched_at:string, five_hour, seven_day, ... }`, each window `{ utilization:number, resets_at:string } | null`. Cache path `~/.ax/quota-cache.json` (`cache.ts:13`).
- route-dispatch.test.ts harness: builds `{harness:"claude", event:"PreToolUse", tool:{name:"Agent", input}, ...}` and asserts `v._tag`.
- `JUDGMENT_RE`: `apps/axctl/src/queries/routing-tune.ts` (the dup to collapse).
- hooks-sdk deps: `effect` only.

---

## PR1 - conserve auto-route

### Task 1: `Verdict.route` + encoding

**Files:** Modify `packages/hooks-sdk/src/verdict.ts`, `packages/hooks-sdk/src/adapters/encode.ts`; Test `packages/hooks-sdk/src/adapters/encode.test.ts`

- [ ] **Step 1: failing test** (extend or create encode.test.ts)

```ts
// packages/hooks-sdk/src/adapters/encode.test.ts
import { describe, expect, test } from "bun:test";
import { encodeVerdict } from "./encode.ts";
import { Verdict } from "../verdict.ts";

describe("encodeVerdict Route", () => {
    test("claude: emits permissionDecision allow + updatedInput", () => {
        const out = encodeVerdict(Verdict.route({ description: "Implement X", model: "sonnet" }), "claude");
        expect(out.exitCode).toBe(0);
        const json = JSON.parse(out.stdout!);
        expect(json.hookSpecificOutput).toEqual({
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { description: "Implement X", model: "sonnet" },
        });
    });
    test("codex: Route degrades to allow (no Agent dispatch / different protocol)", () => {
        const out = encodeVerdict(Verdict.route({ model: "sonnet" }), "codex");
        expect(out).toEqual({ exitCode: 0 });
    });
});
```

- [ ] **Step 2: run -> FAIL** (`bun test packages/hooks-sdk/src/adapters/encode.test.ts`) - `Verdict.route` not a function.

- [ ] **Step 3: implement** - verdict.ts: add the variant carrying the FULL merged input (not just the model).

```ts
// packages/hooks-sdk/src/verdict.ts
export type Verdict =
    | { readonly _tag: "Allow" }
    | { readonly _tag: "Block"; readonly reason: string }
    | { readonly _tag: "Warn"; readonly message: string }
    | { readonly _tag: "Inject"; readonly context: string }
    | { readonly _tag: "Route"; readonly input: Record<string, unknown> };

export const Verdict = {
    allow: { _tag: "Allow" },
    block: (reason: string): Verdict => ({ _tag: "Block", reason }),
    warn: (message: string): Verdict => ({ _tag: "Warn", message }),
    inject: (context: string): Verdict => ({ _tag: "Inject", context }),
    /** Silently rewrite the tool input (PreToolUse allow + updatedInput). `input` is the FULL merged input. */
    route: (input: Record<string, unknown>): Verdict => ({ _tag: "Route", input }),
} as const;
```

encode.ts: add the Route case, gated to claude (codex has no updatedInput protocol here → allow):

```ts
// packages/hooks-sdk/src/adapters/encode.ts (inside the switch, before closing brace)
        case "Route":
            return _harness === "claude"
                ? {
                    exitCode: 0,
                    stdout: JSON.stringify({
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "allow",
                            updatedInput: v.input,
                        },
                    }),
                }
                : { exitCode: 0 };
```
(Rename the `_harness` param to `harness` since it's now used.)

- [ ] **Step 4: run -> PASS**
- [ ] **Step 5: commit** `feat(hooks-sdk): Verdict.route - silent updatedInput rewrite`

---

### Task 2: spend-mode module (pure)

**Files:** Create `packages/hooks-sdk/src/spend-mode.ts`, `packages/hooks-sdk/src/spend-mode.test.ts`

This module owns: the minimal `QuotaSnapshot` type, `readQuotaCacheSync`, `computeSpendMode`, and the single `JUDGMENT_STRONG_RE`.

- [ ] **Step 1: failing test**

```ts
// packages/hooks-sdk/src/spend-mode.test.ts
import { describe, expect, test } from "bun:test";
import { computeSpendMode, DEFAULT_SPEND_CONFIG, JUDGMENT_STRONG_RE } from "./spend-mode.ts";
import type { QuotaSnapshot } from "./spend-mode.ts";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const snap = (o: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
    v: 1,
    fetched_at: new Date(NOW - 30_000).toISOString(), // 30s old → fresh
    five_hour: { utilization: 10, resets_at: new Date(NOW + 3 * 3600_000).toISOString() },
    seven_day: { utilization: 40, resets_at: new Date(NOW + 12 * 3600_000).toISOString() }, // 12h to reset, 60% left
    ...o,
});

describe("computeSpendMode", () => {
    test("splurge: 7d near reset (<24h) + headroom (>25%) + no window near cap", () => {
        const r = computeSpendMode(snap(), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("splurge");
        expect(r.stale).toBe(false);
    });
    test("conserve: 7d NOT near reset (resets in 3 days)", () => {
        const r = computeSpendMode(snap({ seven_day: { utilization: 40, resets_at: new Date(NOW + 72 * 3600_000).toISOString() } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
    });
    test("conserve: 7d near reset but low headroom (only 20% left)", () => {
        const r = computeSpendMode(snap({ seven_day: { utilization: 80, resets_at: new Date(NOW + 12 * 3600_000).toISOString() } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve"); // 100-80=20 not > 25
    });
    test("conserve: a window near its cap (5h at 85%) blocks splurge even with 7d headroom", () => {
        const r = computeSpendMode(snap({ five_hour: { utilization: 85, resets_at: new Date(NOW + 3600_000).toISOString() } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve"); // capFloorPct=80, 85>=80
    });
    test("conserve + stale when cache older than stalenessMs", () => {
        const r = computeSpendMode(snap({ fetched_at: new Date(NOW - 10 * 60_000).toISOString() }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
        expect(r.stale).toBe(true);
    });
    test("conserve when seven_day is null", () => {
        expect(computeSpendMode(snap({ seven_day: null }), NOW, DEFAULT_SPEND_CONFIG).mode).toBe("conserve");
    });
    test("the 5h window never triggers splurge on its own (7d far from reset)", () => {
        const r = computeSpendMode(snap({
            five_hour: { utilization: 10, resets_at: new Date(NOW + 60 * 60_000).toISOString() }, // 5h resets in 1h, lots left
            seven_day: { utilization: 40, resets_at: new Date(NOW + 72 * 3600_000).toISOString() }, // 7d far
        }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
    });
    test("resets_at parse failure on 7d → conserve", () => {
        const r = computeSpendMode(snap({ seven_day: { utilization: 40, resets_at: "not-a-date" } }), NOW, DEFAULT_SPEND_CONFIG);
        expect(r.mode).toBe("conserve");
    });
});

describe("JUDGMENT_STRONG_RE", () => {
    test("matches strong judgment kinds", () => {
        for (const s of ["quality review of X", "PR review", "final review", "design the migration", "audit the auth", "architect the layer", "adversarial review", "code review", "judge the reports"]) {
            expect(JUDGMENT_STRONG_RE.test(s)).toBe(true);
        }
    });
    test("does NOT match spec review (deliberate route-down class)", () => {
        expect(JUDGMENT_STRONG_RE.test("spec review of PR #42")).toBe(false);
        expect(JUDGMENT_STRONG_RE.test("spec-compliance review")).toBe(false);
    });
});
```

- [ ] **Step 2: run -> FAIL**

- [ ] **Step 3: implement**

```ts
// packages/hooks-sdk/src/spend-mode.ts
import { readFileSync } from "node:fs";

export interface QuotaWindow { readonly utilization: number; readonly resets_at: string }
export interface QuotaSnapshot {
    readonly v: 1;
    readonly fetched_at: string;
    readonly five_hour: QuotaWindow | null;
    readonly seven_day: QuotaWindow | null;
    readonly [k: string]: unknown;
}

export type SpendMode = "conserve" | "splurge";
export interface SpendModeResult { readonly mode: SpendMode; readonly reason: string; readonly stale: boolean }

export interface SpendConfig {
    readonly stalenessMs: number;
    readonly nearResetMs7d: number;
    readonly minRemainingPct: number;
    readonly capFloorPct: number;
}
export const DEFAULT_SPEND_CONFIG: SpendConfig = {
    stalenessMs: 5 * 60_000,
    nearResetMs7d: 24 * 3600_000,
    minRemainingPct: 25,
    capFloorPct: 80,
};

const parseMs = (iso: string): number | null => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
};

/**
 * Strong judgment work that must stay on the main/strong model. Matches
 * quality/pr/final/adversarial/code review, design, audit, architect, critique,
 * judge - and deliberately NOT "spec" review (a route-down class). The negative
 * lookbehind-free guard: require the review kinds to not be preceded by "spec".
 */
export const JUDGMENT_STRONG_RE =
    /\b(?:(?:quality|pr|final|adversarial|code)\s+review|design|audit|architect\w*|critique|critic\w*|judg\w*)\b/i;
// Note: a bare "review" or "spec review" does NOT match (only the qualified review kinds above do).

export const computeSpendMode = (
    snapshot: QuotaSnapshot | null,
    nowMs: number,
    config: SpendConfig,
): SpendModeResult => {
    if (snapshot === null) return { mode: "conserve", reason: "no cache", stale: true };
    const fetchedMs = parseMs(snapshot.fetched_at);
    const stale = fetchedMs === null || nowMs - fetchedMs > config.stalenessMs;
    if (stale) return { mode: "conserve", reason: "stale cache", stale: true };

    const sevenDay = snapshot.seven_day;
    if (!sevenDay) return { mode: "conserve", reason: "no 7d window", stale: false };
    const resetMs = parseMs(sevenDay.resets_at);
    if (resetMs === null) return { mode: "conserve", reason: "bad 7d resets_at", stale: false };

    const nearReset = resetMs - nowMs < config.nearResetMs7d;
    const headroom = 100 - sevenDay.utilization > config.minRemainingPct;
    const sevenNearCap = sevenDay.utilization >= config.capFloorPct;
    const fiveNearCap = snapshot.five_hour ? snapshot.five_hour.utilization >= config.capFloorPct : false;

    if (nearReset && headroom && !sevenNearCap && !fiveNearCap) {
        return { mode: "splurge", reason: "7d reset soon with surplus", stale: false };
    }
    return { mode: "conserve", reason: "default", stale: false };
};

/** Sync, fail-open cache read on the fire path (mirrors readRoutingTableSync). */
export const readQuotaCacheSync = (path: string): QuotaSnapshot | null => {
    try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as QuotaSnapshot;
        if (parsed && parsed.v === 1 && typeof parsed.fetched_at === "string") return parsed;
        return null;
    } catch {
        return null;
    }
};

export const defaultQuotaCachePath = (): string => `${process.env.HOME}/.ax/quota-cache.json`;
```

- [ ] **Step 4: run -> PASS** (verify JUDGMENT_STRONG_RE: confirm a plain "review the code" doesn't accidentally match; if the regex over/under-matches the test cases, adjust the alternation and re-run - the test is authoritative).
- [ ] **Step 5: commit** `feat(hooks-sdk): spend-mode signal + sync quota cache reader + judgment regex`

---

### Task 3: `decideVerdict` (pure, ordered)

**Files:** Create `packages/hooks-sdk/src/decide-verdict.ts`, `packages/hooks-sdk/src/decide-verdict.test.ts`

- [ ] **Step 1: failing test** - enumerate the input space; assert each verdict tag.

```ts
// packages/hooks-sdk/src/decide-verdict.test.ts
import { describe, expect, test } from "bun:test";
import { decideVerdict } from "./decide-verdict.ts";

const inp = (o: Partial<Parameters<typeof decideVerdict>[0]>) => ({
    match: null, explicit: false, cheap: false, judgmentStrong: false, routeDownEnforced: true,
    input: { description: "x" }, suggest: "sonnet", ...o,
});

describe("decideVerdict", () => {
    test("judgment + cheap → Warn (rule 0, any mode)", () => {
        expect(decideVerdict(inp({ judgmentStrong: true, explicit: true, cheap: true }))._tag).toBe("Warn");
    });
    test("judgment + cheap → Warn even in splurge", () => {
        expect(decideVerdict(inp({ judgmentStrong: true, explicit: true, cheap: true, routeDownEnforced: false }))._tag).toBe("Warn");
    });
    test("explicit (non-judgment) → Allow, never overridden", () => {
        expect(decideVerdict(inp({ explicit: true, cheap: false }))._tag).toBe("Allow");
        expect(decideVerdict(inp({ explicit: true, cheap: true }))._tag).toBe("Allow"); // explicit cheap, not judgment
    });
    test("match + inherit + conserve → Route(suggest)", () => {
        const v = decideVerdict(inp({ match: true, routeDownEnforced: true }));
        expect(v._tag).toBe("Route");
        if (v._tag === "Route") expect(v.input.model).toBe("sonnet");
    });
    test("match + inherit + splurge → Allow (subtractive: runs on strong inherited model)", () => {
        expect(decideVerdict(inp({ match: true, routeDownEnforced: false }))._tag).toBe("Allow");
    });
    test("no match + inherit → Allow", () => {
        expect(decideVerdict(inp({ match: false }))._tag).toBe("Allow");
    });
    test("judgment + inherit (strong) any mode → Allow (not warned, not routed)", () => {
        expect(decideVerdict(inp({ judgmentStrong: true, explicit: false }))._tag).toBe("Allow");
    });
    test("match + judgment + inherit + conserve → Allow (judgment is NEVER routed down)", () => {
        expect(decideVerdict(inp({ match: true, judgmentStrong: true, routeDownEnforced: true }))._tag).toBe("Allow");
    });
});
```

- [ ] **Step 2: run -> FAIL**

- [ ] **Step 3: implement**

```ts
// packages/hooks-sdk/src/decide-verdict.ts
import { Verdict } from "./verdict.ts";

export interface DecideInput {
    readonly match: boolean;            // matched a route-down class
    readonly explicit: boolean;         // explicit model set
    readonly cheap: boolean;            // explicit model is sonnet/haiku
    readonly judgmentStrong: boolean;   // stays-strong judgment kind
    readonly routeDownEnforced: boolean; // = (mode === conserve)
    readonly input: Record<string, unknown>; // original Agent input (for Route merge)
    readonly suggest: string;           // the class's suggested cheaper model
}

/** Ordered decision; first rule wins. Judgment is rule 0 (never routed/blocked). */
export const decideVerdict = (i: DecideInput): Verdict => {
    // Rule 0: judgment work sent on a cheap model → warn (any mode).
    if (i.judgmentStrong && i.cheap) {
        return Verdict.warn(
            "judgment work (review/design/audit) is the catch-rate gate - prefer the strong model (drop the cheap `model:` or set model:opus).",
        );
    }
    // Rule 1: an explicit model is a deliberate choice - never override.
    if (i.explicit) return Verdict.allow;
    // Rule 2: conserve + forgotten route-down → silently rewrite to the cheaper
    // tier. `!judgmentStrong` enforces judgment-precedence: judgment work that
    // also matched a class (class/regex drift) is NEVER routed down.
    if (i.match && i.routeDownEnforced && !i.judgmentStrong) {
        return Verdict.route({ ...i.input, model: i.suggest });
    }
    // Rule 3: everything else (incl. splurge+match+inherit = strong inherited model). 
    return Verdict.allow;
};
```

- [ ] **Step 4: run -> PASS** (all 8 assertions, covering the distinct outcomes across the 32-cell input space; many cells collapse to the same verdict).

- [ ] **Step 5: commit** `feat(hooks-sdk): decideVerdict - ordered route/warn/allow decision`

---

### Task 4: wire route-dispatch to spend mode + auto-route

**Files:** Modify `packages/hooks-sdk/src/hooks/route-dispatch.ts`, `packages/hooks-sdk/src/hooks/route-dispatch.test.ts`

- [ ] **Step 1: rewrite the hook body** to compute inputs + delegate to `decideVerdict`.

```ts
// packages/hooks-sdk/src/hooks/route-dispatch.ts (run body)
run: (event) =>
    Effect.sync(() => {
        const input = (event.tool?.input ?? {}) as Record<string, unknown>;
        const modelRaw = input.model;
        const explicit = typeof modelRaw === "string" && modelRaw.length > 0;
        const cheap = explicit && /sonnet|haiku/i.test(modelRaw as string);
        const subagentType = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
        const rawDescription = typeof input.description === "string" ? input.description : undefined;
        const rawPrompt = typeof input.prompt === "string" ? input.prompt.slice(0, 120) : undefined;
        const description = rawDescription ?? rawPrompt;

        const table = loadRoutingTableOrDefault();
        const match = matchRoutingTable(table, description, subagentType);
        const judgmentStrong = description !== undefined && JUDGMENT_STRONG_RE.test(description);

        // mode (conserve unless a fresh cache says splurge). Env override wins.
        const envMode = process.env.AX_SPEND_MODE;
        const computed = computeSpendMode(readQuotaCacheSync(defaultQuotaCachePath()), Date.now(), DEFAULT_SPEND_CONFIG);
        const mode = envMode === "conserve" || envMode === "splurge" ? envMode : computed.mode;

        return decideVerdict({
            match: match !== null,
            explicit,
            cheap,
            judgmentStrong,
            routeDownEnforced: mode === "conserve",
            input,
            suggest: match?.suggest ?? "sonnet",
        });
    }),
```
Add imports: `decideVerdict` from `../decide-verdict.ts`; `computeSpendMode, readQuotaCacheSync, defaultQuotaCachePath, DEFAULT_SPEND_CONFIG, JUDGMENT_STRONG_RE` from `../spend-mode.ts`.

- [ ] **Step 2: update route-dispatch.test.ts** - the existing tests asserted `Warn`; now conserve+match+inherit → `Route`. Update them, and add: explicit-cheap on a route-down class → Allow; judgment-cheap → Warn; an `AX_SPEND_MODE=splurge` env case → match+inherit → Allow. Run `bun test packages/hooks-sdk/src/hooks/route-dispatch.test.ts` → PASS. (The harness sets `process.env.AX_SPEND_MODE`; reset it between tests.)

- [ ] **Step 3: backtest** `bun packages/hooks-sdk/src/hooks/route-dispatch.ts` is the fire path; run `ax hooks backtest ~/.ax/hooks/route-dispatch.ts --days=2` - confirm it replays without error and that `Implement …` rows now resolve to a route verdict in conserve (the backtest reports verdicts).

- [ ] **Step 4: LIVE SMOKE (the load-bearing verification)** - confirm the two unverified mechanisms actually work in Claude Code:
  1. **updatedInput rewrite:** install the updated hook (`ax hooks install <abs route-dispatch.ts>`), then in a scratch Claude Code session dispatch an Agent with `description:"Implement something"` and NO model; verify (via `ax dispatches` after, or the hook's own stderr/transcript) that it ran on **sonnet**, not the inherited model. If `updatedInput` does NOT take effect, FALL BACK to the `permissionDecision: deny` + reason encoding (block) and record that finding - do not ship a silent no-op.
  2. **systemMessage warn reaches the model:** dispatch a `quality review …` with `model:sonnet`; confirm the warn surfaces to the agent. If it only reaches the user, note it (warn is advisory; acceptable, but record the truth).
  PASTE the smoke evidence.

- [ ] **Step 5: commit** `feat(hooks): route-dispatch auto-routes in conserve via spend mode`

---

### Task 5: collapse the duplicate judgment regex

**Files:** Modify `apps/axctl/src/queries/routing-tune.ts`

- [ ] **Step 1:** replace the local `JUDGMENT_RE` definition with an import of `JUDGMENT_STRONG_RE` from `@ax/hooks-sdk` (confirm the export path - `packages/hooks-sdk/src/spend-mode.ts`; check how axctl imports hooks-sdk elsewhere, e.g. routing-table). Keep the exported name stable for routing-tune's callers, or re-export. Run the routing-tune tests (`bun test apps/axctl/src/queries/routing-tune.test.ts`) - adjust any test whose expectation shifts because the regex is now the unified one (the judgment set should be equivalent or a documented superset/subset; reconcile and note).
- [ ] **Step 2: commit** `refactor(routing): single judgment regex shared by hook + routing-tune`

---

### Task 6: routing-table spendMode thresholds + SKILL.md reconcile

**Files:** Modify `packages/hooks-sdk/src/routing-table.ts` (schema), `skills/efficient-dispatch/SKILL.md`

- [ ] **Step 1:** add an optional `spendMode` block to `RoutingTableSchema` (thresholds: `stalenessMs`, `nearResetMs7d`, `minRemainingPct`, `capFloorPct`), defaulting to `DEFAULT_SPEND_CONFIG` when absent. Wire the hook to read it from the loaded table (override `DEFAULT_SPEND_CONFIG`). Add a schema test.
- [ ] **Step 2:** SKILL.md - find the line saying "the route-dispatch hook **warns** when you forget" and rewrite to: "the route-dispatch hook **auto-routes** a forgotten mechanical dispatch to the cheaper model in conserve mode; near a 7d reset (splurge) it relaxes so work runs on the strong model; it **warns** when judgment work is sent on a cheap model." Keep the rest.
- [ ] **Step 3: commit** `feat(hooks): spendMode thresholds in routing table + reconcile efficient-dispatch skill`

---

### Task 7: PR1 verify + PR

- [ ] **Step 1** `bun test` (repo-wide) → 0 fail. `bun run typecheck` → clean. `bun scripts/check-no-node-fs.ts` → clean (note: spend-mode.ts uses `node:fs` in hooks-sdk - confirm the gate's allowlist covers hooks-sdk like routing-table.ts; if not, add it the same way).
- [ ] **Step 2** push + PR:
```bash
git push -u origin feat/dispatch-economy
gh pr create --title "feat: quota-aware dispatch economy (PR1 - conserve auto-route)" --body "..."
```
PR body: conserve auto-route via Verdict.route (silent rewrite) + computeSpendMode (full, incl. splurge logic, but splurge is only *consumed* - subtractively - here: splurge → no rewrite → strong inherited model); judgment-cheap warn; single judgment regex. **Flag the behavior change** (warn→auto-route) + the live-smoke evidence that updatedInput works. Note PR2 follows with freshness + the /dojo nudge + statusline surface + measurement.

---

## PR2 - splurge freshness + /dojo nudge + surface + measurement

(Branch off the merged PR1, or stack on `feat/dispatch-economy`.)

### Task 8: refresh-quota SessionStart hook (+ splurge → /dojo nudge)

**Files:** Create `packages/hooks-sdk/src/hooks/refresh-quota.ts`, `packages/hooks-sdk/src/hooks/refresh-quota.test.ts`

- [ ] **Step 1: failing test** - factor the nudge decision as a pure fn `spendNudge(result) → string | null` (so it's testable without spawning): splurge → a `/dojo` nudge string; conserve/stale → null.

```ts
// refresh-quota.test.ts
import { describe, expect, test } from "bun:test";
import { spendNudge } from "./refresh-quota.ts";
describe("spendNudge", () => {
    test("splurge → /dojo nudge mentioning remaining % and hours", () => {
        const s = spendNudge({ mode: "splurge", reason: "x", stale: false }, { remainingPct: 60, hoursToReset: 12 });
        expect(s).toContain("/dojo");
        expect(s).toContain("60%");
        expect(s).toContain("12h");
    });
    test("conserve → null (no nudge)", () => {
        expect(spendNudge({ mode: "conserve", reason: "x", stale: false }, { remainingPct: 60, hoursToReset: 12 })).toBeNull();
    });
});
```

- [ ] **Step 2: run -> FAIL**
- [ ] **Step 3: implement** - `refresh-quota.ts`: a SessionStart hook that (a) shells out to refresh the cache, (b) reads it, (c) computes mode, (d) returns `Verdict.inject(nudge)` when splurge else `Verdict.allow`. Mirror enforce-worktree.ts structure.

```ts
// packages/hooks-sdk/src/hooks/refresh-quota.ts
import { Effect } from "effect";
import { defineHook, runMain } from "../define.ts";
import { Verdict } from "../verdict.ts";
import { computeSpendMode, DEFAULT_SPEND_CONFIG, defaultQuotaCachePath, readQuotaCacheSync, type SpendModeResult } from "../spend-mode.ts";

export const spendNudge = (
    r: SpendModeResult,
    facts: { remainingPct: number; hoursToReset: number },
): string | null =>
    r.mode === "splurge"
        ? `splurge window: ~${facts.remainingPct}% of your 7d budget resets in ${facts.hoursToReset}h - run /dojo to spend it on self-improvement.`
        : null;

const hook = defineHook({
    name: "refresh-quota",
    events: ["SessionStart"],
    run: () =>
        Effect.gen(function* () {
            // refresh the cache off the hot path (SessionStart fires once)
            yield* Effect.tryPromise(() => Bun.spawn(["ax", "quota", "--fresh"], { stdout: "ignore", stderr: "ignore" }).exited)
                .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            const snap = readQuotaCacheSync(defaultQuotaCachePath());
            const result = computeSpendMode(snap, Date.now(), DEFAULT_SPEND_CONFIG);
            if (snap?.seven_day && result.mode === "splurge") {
                const remainingPct = Math.round(100 - snap.seven_day.utilization);
                const hoursToReset = Math.max(1, Math.round((Date.parse(snap.seven_day.resets_at) - Date.now()) / 3600_000));
                const nudge = spendNudge(result, { remainingPct, hoursToReset });
                if (nudge) return Verdict.inject(nudge);
            }
            return Verdict.allow;
        }),
});
export default hook;
if (import.meta.main) void runMain(hook);
```
(Verify `Bun.spawn` is acceptable in a hook run that returns `Effect<Verdict, never, GitEnv>` - the run type allows side effects; SessionStart is off the hot path. If `ax` isn't on PATH in the hook env, fall back to `bun <repo>/apps/axctl/bin/axctl quota --fresh` or skip the refresh and just read the cache + note it.)

- [ ] **Step 4: run -> PASS** + a backtest/smoke of SessionStart (install the hook, start a session in a splurge state - or temporarily force `AX_SPEND_MODE`-style via a test cache - and confirm the nudge appears).
- [ ] **Step 5: commit** `feat(hooks): refresh-quota SessionStart hook + splurge /dojo nudge`

---

### Task 9: install wiring - the two new hooks + interval refresh LaunchAgent

**Files:** Modify the hook scaffold/install (`apps/axctl/src/hooks/...` - find where `ax hooks init` writes the default hook set, and where `ax install` writes LaunchAgents)

- [ ] **Step 1:** make `ax hooks init` scaffold `refresh-quota.ts` alongside route-dispatch (so a fresh install gets it). Confirm the SessionStart provider wiring (the codec that writes `~/.claude/settings.json` SessionStart entries).
- [ ] **Step 2:** add a periodic-refresh LaunchAgent (mac: a plist with `StartInterval` ~300s running `ax quota`) installed by `ax install`; mirror the existing `com.necmttn.ax-watch` plist creation (find it under scripts/ or apps/axctl/src/...). Linux/other: document a cron equivalent or skip with a note. Idempotent install.
- [ ] **Step 3:** verify `ax hooks init` produces refresh-quota + `ax install` lays down the timer plist (dry-run/inspect the written files). 
- [ ] **Step 4: commit** `feat(install): scaffold refresh-quota hook + interval quota-refresh LaunchAgent`

---

### Task 10: surface SpendMode + staleness in quota render

**Files:** Modify `apps/axctl/src/quota/format.ts`, its test

- [ ] **Step 1: failing test** - `renderStatusline`/`renderQuotaTable` append the mode: `CONSERVE` / `SPLURGE -> /dojo` / `mode? (stale Nm)`. Use the shared `computeSpendMode` (import from `@ax/hooks-sdk`) so it's the single source of truth.

```ts
// in format.test.ts
test("statusline shows SPLURGE -> /dojo when computeSpendMode says splurge", () => {
    // build a snapshot in splurge; expect the line to contain "SPLURGE" and "/dojo"
});
test("statusline shows CONSERVE otherwise; (stale Nm) when stale", () => { /* ... */ });
```

- [ ] **Step 2-4:** implement the append (compute mode from the snapshot + now; render the badge), run tests, confirm `ax quota --statusline` live shows the badge.
- [ ] **Step 5: commit** `feat(quota): render spend mode + staleness (single source = computeSpendMode)`

---

### Task 11: measurement lens

**Files:** Modify `apps/axctl/src/queries/dispatch-analytics.ts` (or a small new query) + the `ax dispatches` command

- [ ] **Step 1:** add a lens that correlates spend mode with route outcomes - e.g. `ax dispatches --economy [--days=N]` showing, over the window: how many inherit dispatches matched a route-down class (would-be auto-routes), how many ran cheap vs expensive, and (if recoverable) the spend mode at dispatch time. The route verdicts already land in `hook_command_invocation` (the `effect` field) - join/count those. Keep it a read over existing telemetry (no new table). Test the query shaping with the fake client.
- [ ] **Step 2:** docs/cli.md + llms.txt + CLAUDE.md note for the new flag/command; `bun run check:cli-reference` → 0.
- [ ] **Step 3: commit** `feat(dispatches): spend-mode-aware effectiveness lens`

---

### Task 12: PR2 verify + PR

- [ ] **Step 1** `bun test` repo-wide → 0 fail; `bun run typecheck` → clean; `check:cli-reference` + `check-no-node-fs` → clean.
- [ ] **Step 2** push + PR `feat: quota-aware dispatch economy (PR2 - splurge freshness + /dojo nudge + surface + measurement)`. Body: SessionStart refresh + interval LaunchAgent (freshness), splurge→/dojo nudge (the in-harness window-end trigger), statusline surface + staleness, measurement lens. Reference the spec + PR1.
