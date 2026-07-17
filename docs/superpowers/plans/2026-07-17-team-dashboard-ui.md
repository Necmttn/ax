# Team Dashboard UI (studio /team real boards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the studio `/team` page to the daemon `GET /api/team?org=<org>` → `TeamBoards` endpoint and render real adoption / skill-matrix / spend / cold-start panels, removing the paywall teaser + harnesses-as-team placeholder (keep `?demo` - the marketing site iframes it).

**Architecture:** A pure view-model module (`team-boards-model.ts`, bun:test-covered) maps `TeamBoards` → display rows; `team-metrics.tsx` gains a `TeamBoardsView` that `useQuery`s `api.team()` and renders with the file's existing `.v-tm-*` / `.v-team-*` / `.v-mc-*` / `.rdx-*` design system. Mock teaser (MOCK_*, HeroStrip, TeamPaywall, OutcomeTable, unlock/paywall gating) and the live harnesses-as-team board (UnlockedBoard + live builders) are deleted; the demo (`?demo`) board stays byte-identical visually.

**Tech Stack:** React 19 + @tanstack/react-query, bun:test, TypeScript strict, vite (daemon target proxies `/api` → `AX_DAEMON_PORT`).

## Global Constraints

- Scope IN: `apps/studio/src/instrument/team-metrics.tsx`, `apps/studio/src/api.ts`, `apps/studio/package.json` (new workspace dep), new `apps/studio/src/instrument/team-boards-model.ts` + test.
- Scope OUT: no backend/route changes, no `compileTeam`/`TeamBoards` changes, no CSS/design-system additions, no site changes.
- `?demo` path MUST keep working (iframed by `apps/site/app/routes/teams.tsx`).
- Import `TeamBoards` type-only from `@ax/community-compile/team` (exports map: `./team` → `src/team-compile.ts`).
- Respect null cost: `spend.costUsd` meaningful only when `spend.costContributors > 0`; per-model cost only when `row.costContributors > 0`.
- No hardcoded colors - reuse `var(--accent)`, `var(--pri)`, `var(--gold)`, `var(--violet)`, `var(--blue)`, existing `toneFor`.
- Gates: `bun run typecheck` exit 0 (real `$?`), `bun test apps/studio` green, described render verification.
- One conventional commit at the end; `git add -A ':!BRIEF.md' ':!REPORT.md'`.

---

### Task 1: Dep + api client `team()` call

**Files:**
- Modify: `apps/studio/package.json` (add `"@ax/community-compile": "workspace:*"` to dependencies)
- Modify: `apps/studio/src/api.ts`

**Interfaces:**
- Produces: `api.team(org?: string): Promise<TeamBoards>` - GET `/api/team` (append `?org=<encoded>` when org given), via existing `jsonFetch` (same pattern as `graphExplorer`).

- [ ] **Step 1:** Add dep to `apps/studio/package.json` dependencies:
```json
"@ax/community-compile": "workspace:*",
```
- [ ] **Step 2:** Run `bun install` from worktree root. Expected: lockfile updates, exit 0.
- [ ] **Step 3:** In `api.ts` add near other type imports:
```ts
import type { TeamBoards } from "@ax/community-compile/team";
```
and inside the `api` object (near `costModels`):
```ts
/** Team boards - aggregate of pushed team snapshots (LOCAL daemon rollup). */
team: (org?: string): Promise<TeamBoards> =>
    jsonFetch(org ? `/api/team?org=${encodeURIComponent(org)}` : "/api/team"),
```
- [ ] **Step 4:** `bun run typecheck` at repo root. Expected exit 0.

### Task 2: Pure view-model + tests (TDD, dispatchable)

**Files:**
- Create: `apps/studio/src/instrument/team-boards-model.ts`
- Test: `apps/studio/src/instrument/team-boards-model.test.ts`

**Interfaces:**
- Consumes: `TeamBoards` from `@ax/community-compile/team`.
- Produces:
```ts
export interface TeamHeroTile { label: string; value: string; small?: string; sub: string; tone: "up" | "flat" }
export interface TeamSkillView { skill: string; devs: number; runs: number; sessions: number; medianRuns: number; devShare: number /* 0-1 of max devs */ }
export interface TeamModelView { model: string; tokens: string; share: number /* 0-1 */; cost: string /* "-" when no contributors */ }
export interface TeamBoardsView {
    empty: boolean;                 // contributing === 0
    activation: string;             // "3 devs contributing · 2 identified · 1 anon"
    hero: TeamHeroTile[];           // devs / sessions / active days / spend
    skills: TeamSkillView[];
    models: TeamModelView[];
    tokens: { prompt: string; completion: string; total: string };
    efficiency: { toolCalls: string; failureRate: string; verificationShare: string };
    costNote: string | null;        // "2 of 3 devs report cost" | "no cost data pushed" (when contributors < contributing)
}
export function buildTeamView(b: TeamBoards): TeamBoardsView
```
Formatting: reuse local copies of fmt helpers (fmtUsd/fmtBig semantics identical to team-metrics.tsx; export them from the model module and have team-metrics.tsx import them to stay DRY - move `fmtUsd`/`fmtBig` here).

Behavior specs (each a test):
1. `empty` true iff `coverage.contributing === 0`.
2. Activation line: contributing 3, identified 2 → `"3 devs contributing · 2 identified · 1 anon"`; identified === contributing → no anon segment (`"3 devs contributing · 3 identified"`); contributing 1 → `"1 dev contributing …"` singular.
3. Hero tiles: devs tile value `String(contributing)`; sessions tile value fmtBig(total) sub `avg N/dev` (average rounded to 1 decimal, trailing `.0` stripped); active-days same; spend tile value fmtUsd(costUsd) when `costContributors > 0`, else value `"-"` sub `"no cost data pushed"`.
4. `costNote`: null when `costContributors === contributing && contributing > 0`; `"no cost data pushed"` when 0 contributors; `"2 of 3 devs report cost"` otherwise.
5. Skills: `devShare = devs / max(devs across rows)` (1 for the top row; rows already sorted by compileTeam - preserve order).
6. Models: `share` passthrough; `cost` = `"-"` when `row.costContributors === 0` else fmtUsd; `tokens` = fmtBig.
7. Efficiency: percentages rendered `Math.round(rate*100) + "%"`.

- [ ] **Step 1:** Write `team-boards-model.test.ts` with a `boards()` fixture factory (plain object literal implementing `TeamBoards`) and the 7 specs above as failing tests.
- [ ] **Step 2:** Run `bun test apps/studio/src/instrument/team-boards-model.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `team-boards-model.ts` (pure, no react import).
- [ ] **Step 4:** Run same test → PASS.

### Task 3: Rewrite team-metrics.tsx

**Files:**
- Modify: `apps/studio/src/instrument/team-metrics.tsx`

**Interfaces:**
- Consumes: `api.team()` (Task 1), `buildTeamView`, `fmtUsd`, `fmtBig` (Task 2).
- Produces: `TeamMetricsRoute` (router import unchanged).

- [ ] **Step 1:** Delete: `MOCK_*` datasets + `mockDays`, `HeroStrip`, `TeamPaywall`, `OutcomeTable`, `BOOK_A_CALL_URL`, `Check`, `isUnlocked`, `isForcedLock`, `UnlockedBoard`, live builders (`buildRoster`, `buildProjects`, `harnessEntities`, `memberEntities`, `HarnessRow`), `fetchMembers` import, `orgMode`/`teaser` branches in `Board`/`RosterCard`, live `useQuery`s (`sessQ`, `costQ`, `memQ`), `outcome` field on `RosterEntity`, teaser auto-select `useEffect`. Move `fmtUsd`/`fmtBig` imports to the model module. `Board` becomes demo-only (`demo` prop dropped, always demo data).
- [ ] **Step 2:** Add `TeamBoardsView` component: `useQuery({ queryKey: ["team", "boards"], queryFn: () => api.team() })`; states:
  - loading → existing `Notice` card ("loading team boards");
  - error → `Notice` ("team boards unavailable", message + hint: needs `ax serve` with the team endpoint);
  - `view.empty` → `Notice` ("no team data yet", "No snapshots pushed. Run `ax team push` from a bound repo …");
  - data → mast (`.v-tm-mast`/`.v-team-org`, ring "org rollup") + activation line (`.rdx-label .v-tm-sub`) + hero tiles (`.v-tm-hero`/`.v-tm-herotile`) + grid (`.v-tm-grid`): skill-matrix table (`.rdx-card .v-team-roster`, `table.v-team-rt` cols: skill / devs(+bar `.v-tm-bar` width devShare) / runs / sessions / median) and model-mix card (`.rdx-card .v-mc-split` rows like MODEL CHANNELS: swatch `toneFor(model)`, share % · tokens · cost, bar) + tokens/efficiency footer rows inside the spend card (`.v-mc-meta` labels: prompt/completion/total; tool calls / failure rate / verification share).
- [ ] **Step 3:** `TeamMetricsRoute`: `isDemo()` → demo Board (unchanged markup); else `<div className="v-tm"><TeamBoardsView /></div>`.
- [ ] **Step 4:** `bun run typecheck` exit 0; `bun test apps/studio` green.
- [ ] **Step 5:** Commit `feat(studio): render real team boards on /team` (single commit at END after Task 4 verification - do not commit mid-way; brief demands one commit).

### Task 4: Render verification

- [ ] **Step 1:** Stub daemon: write scratchpad `team-stub.ts` - `Bun.serve` on 17399 answering `GET /api/team` with a realistic `TeamBoards` JSON (3 devs, 2 identified, mixed skills, one null-cost dev semantics via costContributors 2, 3 models), `/api/version` minimal `{ ok: true }`-ish, everything else 404.
- [ ] **Step 2:** `AX_DAEMON_PORT=17399 bun x vite dev` in `apps/studio` (background), open `http://localhost:5173/team` via cmux/agent-browser, screenshot boards; also `/team?demo` (demo intact) and stop stub → reload `/team` (error state).
- [ ] **Step 3:** Kill background processes. Record findings in report.

## Self-Review

- Spec coverage: data hook (T1), panels adoption/skills/spend/cold-start (T2+T3), mock-teaser removal (T3 step 1), loading/empty/error (T3 step 2), theme tokens reused, demo preserved (site iframe). ✓
- No placeholders: concrete signatures + class names given; JSX detail lives in T3 step 2 spec with exact class hooks. ✓
- Types consistent: `TeamBoardsView` name used in both T2 (model) and T3 (component) - RENAME: model interface stays `TeamBoardsView`, the React component is `TeamBoardsPanel` to avoid collision. T3 references adjusted accordingly.
