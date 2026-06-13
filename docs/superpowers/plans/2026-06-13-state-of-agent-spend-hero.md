# Measured-Spend Profile Hero (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lead the `/u/<login>` profile and its OG share card with a measured monthly-spend headline (`~$214/mo · measured from 142 sessions · not a screenshot`), out-receipting aistack.to's hand-typed number on its own metric.

**Architecture:** Pure derivation (`monthlyUsd`/`buildHero`) over data already in `ProfileV1` - no gist schema change. The site route renders a new hero block above the existing vitals ledger; the CF Pages OG function normalises the same spend to a monthly figure. Window-total spend (`stats.cost_usd` over `window_days`) is scaled to a 30-day month so the headline is comparable across windows.

**Tech Stack:** TanStack Start SPA (`apps/site/app`), CF Pages Functions + `workers-og` (`apps/site/functions`), bun:test, TypeScript strict.

**Scope note:** This plan is Stage 1 of the [State of Agent Spend spec](../specs/2026-06-13-state-of-agent-spend-design.md), narrowed during planning. The spec's Stage 1 also listed **tool takes** (derived `stack-choice` patterns + optional manual override). Code inspection shows `apps/axctl/src/profile/taste.ts` *defers* stack-choice derivation ("needs dep/import signals") - there is no data source, and the manual-override path needs a new input + schema + publish wiring. Both are a separate subsystem from rendering the hero, so they move to **Stage 1.1** (own plan). This plan ships the share artifact and registration driver - pure render over existing data.

**Convention checks before you start:**
- Tests run from the worktree root with `bun test <path>` (repo-wide bun:test).
- CSS vars in use: `--green`, `--muted`, `--mono`, `--ink`, `--line` (see `apps/site/app/styles/globals.css`).
- The route's money/int formatters already exist: `fmtMoney` (`$` + compact), `fmtInt` (`apps/site/app/routes/u.$login.tsx:143-147`).

---

### Task 1: Pure hero derivation module

**Files:**
- Create: `apps/site/app/lib/hero.ts`
- Test: `apps/site/app/lib/hero.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/site/app/lib/hero.test.ts
import { describe, expect, test } from "bun:test";
import { monthlyUsd, buildHero } from "./hero";
import type { ProfileV1 } from "./community";

const base: ProfileV1 = {
    v: 1,
    github: "necmttn",
    generated_at: "2026-06-13T00:00:00Z",
    window_days: 30,
    stats: {
        sessions: 142,
        active_days: 26,
        streak_days: 12,
        tokens: { prompt: 1, completion: 1, total: 38_000_000 },
        cost_usd: 214.3,
        models: [{ name: "fable", share: 0.6 }, { name: "haiku", share: 0.4 }],
        harnesses: ["claude-code"],
    },
    rig: { skills: [{ name: "tdd", source: "superpowers", runs: 88 }], hooks: [], routing_table: true },
};

describe("monthlyUsd", () => {
    test("30-day window passes through", () => {
        expect(monthlyUsd(200, 30)).toBe(200);
    });
    test("14-day window scales up to a month", () => {
        expect(monthlyUsd(140, 14)).toBeCloseTo(300);
    });
    test("zero/negative window does not divide by zero", () => {
        expect(monthlyUsd(50, 0)).toBe(50);
    });
});

describe("buildHero", () => {
    test("derives monthly spend, counts, and provenance", () => {
        const h = buildHero(base);
        expect(h.monthlyUsd).toBeCloseTo(214.3);
        expect(h.models).toBe(2);
        expect(h.skills).toBe(1);
        expect(h.sessions).toBe(142);
        expect(h.provenance).toBe("measured from 142 sessions over 30d · not a screenshot");
    });
    test("--no-cost profile omits monthly spend", () => {
        const { cost_usd: _omit, ...stats } = base.stats;
        const h = buildHero({ ...base, stats });
        expect(h.monthlyUsd).toBeUndefined();
    });
    test("singular session phrasing", () => {
        const h = buildHero({ ...base, stats: { ...base.stats, sessions: 1 } });
        expect(h.provenance).toContain("1 session over");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/site/app/lib/hero.test.ts`
Expected: FAIL - `Cannot find module './hero'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/site/app/lib/hero.ts
// Pure derivation of the /u hero stat row. No JSX, no IO - unit-tested in
// hero.test.ts. stats.cost_usd is the spend TOTAL over window_days
// (apps/axctl/src/profile/render.ts: stats.cost_usd = cost.total_cost_usd
// for sinceDays: windowDays), so it is normalised to a 30-day month here to
// keep the headline comparable to aistack's monthly figure.
import type { ProfileV1 } from "./community";

export function monthlyUsd(total: number, windowDays: number): number {
    if (windowDays <= 0) return total;
    return (total * 30) / windowDays;
}

export interface Hero {
    readonly monthlyUsd?: number; // omitted on --no-cost profiles
    readonly models: number;
    readonly skills: number;
    readonly sessions: number;
    readonly provenance: string;
}

export function buildHero(p: ProfileV1): Hero {
    const sessions = p.stats.sessions;
    return {
        monthlyUsd: p.stats.cost_usd !== undefined
            ? monthlyUsd(p.stats.cost_usd, p.window_days)
            : undefined,
        models: p.stats.models.length,
        skills: p.rig.skills.length,
        sessions,
        provenance: `measured from ${sessions.toLocaleString("en-US")} session${sessions === 1 ? "" : "s"} over ${p.window_days}d · not a screenshot`,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/site/app/lib/hero.test.ts`
Expected: PASS - 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/site/app/lib/hero.ts apps/site/app/lib/hero.test.ts
git commit -m "feat(site): pure hero derivation - monthly spend + provenance"
```

---

### Task 2: Render the hero block on `/u/<login>`

**Files:**
- Modify: `apps/site/app/routes/u.$login.tsx` (add import; insert hero block after `</header>`; remove the `est. spend` vital from the ledger)

- [ ] **Step 1: Add the import**

Find the `~/lib/window-chart` import block (around `apps/site/app/routes/u.$login.tsx:21-29`) and add below it:

```tsx
import { buildHero } from "~/lib/hero";
```

- [ ] **Step 2: Insert the hero block**

In `ProfilePage`'s returned JSX, immediately after the closing `</header>` of `pf-mast` and before `{/* vitals ledger */}`, insert:

```tsx
            {/* hero: the measured headline - receipts, not a screenshot */}
            {(() => {
                const hero = buildHero(p);
                return (
                    <section className="pf-hero" aria-label="headline">
                        <div className="pf-hero-spend">
                            {hero.monthlyUsd !== undefined ? (
                                <>
                                    <span className="pf-hero-num">~{fmtMoney(hero.monthlyUsd)}</span>
                                    <span className="pf-hero-per">/mo</span>
                                </>
                            ) : (
                                <>
                                    <span className="pf-hero-num">{fmtInt(hero.sessions)}</span>
                                    <span className="pf-hero-per">sessions</span>
                                </>
                            )}
                        </div>
                        <span className="pf-hero-prov">{hero.provenance}</span>
                        <div className="pf-hero-row">
                            <Vital num={fmtInt(hero.models)} label="models" />
                            <Vital num={fmtInt(hero.skills)} label="skills" />
                            <Vital num={fmtInt(hero.sessions)} label="sessions" />
                        </div>
                    </section>
                );
            })()}
```

- [ ] **Step 3: Remove the now-duplicated est. spend vital from the ledger**

In the `{/* vitals ledger */}` section, delete this exact line (the monthly figure now lives in the hero):

```tsx
                {p.stats.cost_usd !== undefined && <Vital num={`~${fmtMoney(p.stats.cost_usd)}`} label="est. spend" />}
```

- [ ] **Step 4: Verify it typechecks**

Run: `cd apps/site && bun run build`
Expected: build succeeds (no TS error referencing `u.$login.tsx` or `hero.ts`). Note: site `bun run typecheck` requires a prior build (route/content codegen) per project CLAUDE.md - `bun run build` is the gate here.

- [ ] **Step 5: Commit**

```bash
git add apps/site/app/routes/u.\$login.tsx
git commit -m "feat(site): lead /u profile with measured \$/mo hero"
```

---

### Task 3: Hero styles

**Files:**
- Modify: `apps/site/app/styles/globals.css` (append hero rules near the other `.pf-*` rules)

- [ ] **Step 1: Append the CSS**

Add to `apps/site/app/styles/globals.css` (after the `.pf-ledger` / `.pf-vital` block - search for `.pf-vital`):

```css
.pf-hero { display: flex; flex-direction: column; gap: 8px; margin: 32px 0 12px; }
.pf-hero-spend { display: flex; align-items: baseline; gap: 10px; }
.pf-hero-num { font-family: var(--mono); font-size: 76px; font-weight: 700; line-height: 1; color: var(--green); }
.pf-hero-per { font-family: var(--mono); font-size: 24px; color: var(--muted); }
.pf-hero-prov { font-family: var(--mono); font-size: 13px; color: var(--muted); letter-spacing: 0.5px; }
.pf-hero-row { display: flex; gap: 32px; margin-top: 16px; }
@media (max-width: 640px) {
    .pf-hero-num { font-size: 56px; }
}
```

- [ ] **Step 2: Verify the build still succeeds**

Run: `cd apps/site && bun run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/site/app/styles/globals.css
git commit -m "style(site): hero spend headline + stat row"
```

---

### Task 4: `perMonthUsd` helper in the OG kit

**Files:**
- Modify: `apps/site/functions/_lib/og-kit.ts` (add helper next to `compactUsd`)
- Test: `apps/site/functions/_lib/og-kit.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `apps/site/functions/_lib/og-kit.test.ts` (and add `perMonthUsd` to the import list at the top of that file):

```ts
import { perMonthUsd } from "./og-kit";

describe("perMonthUsd", () => {
    test("30-day window passes through", () => {
        expect(perMonthUsd(200, 30)).toBe(200);
    });
    test("14-day window scales up", () => {
        expect(perMonthUsd(140, 14)).toBeCloseTo(300);
    });
    test("guards divide-by-zero", () => {
        expect(perMonthUsd(50, 0)).toBe(50);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/site/functions/_lib/og-kit.test.ts`
Expected: FAIL - `perMonthUsd` is not exported.

- [ ] **Step 3: Add the helper**

In `apps/site/functions/_lib/og-kit.ts`, immediately after the `compactUsd` export (around line 53-54), add:

```ts
/** Window-total USD normalised to a 30-day month (mirrors app/lib/hero.ts;
 * functions and the SPA are separate bundles, so the one-liner lives in
 * both). */
export const perMonthUsd = (total: number, windowDays: number): number =>
    windowDays > 0 ? (total * 30) / windowDays : total;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/site/functions/_lib/og-kit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/site/functions/_lib/og-kit.ts apps/site/functions/_lib/og-kit.test.ts
git commit -m "feat(site): perMonthUsd helper for the OG card"
```

---

### Task 5: OG card leads monthly spend + provenance footer

**Files:**
- Modify: `apps/site/functions/og-profile/[login].ts`

- [ ] **Step 1: Import the helper**

In the `og-kit` import block (`apps/site/functions/og-profile/[login].ts:19-21`), add `perMonthUsd` to the named imports:

```tsx
    esc, statHtml, footerHtml, blockLogoHtml, compactNumber, compactUsd, perMonthUsd, loadOgFonts,
```

- [ ] **Step 2: Normalise the gist-profile spend to monthly**

In the `else if (gistProfile)` branch (around line 192-194), replace:

```tsx
        spendUsd     = s.cost_usd ?? null;
```

with:

```tsx
        spendUsd     = s.cost_usd != null ? perMonthUsd(s.cost_usd, gistProfile.window_days) : null;
```

(The placeholder `stub` branch keeps `estimated_spend_usd` unchanged - it has no window and is a fallback card.)

- [ ] **Step 3: Relabel the spend stat to `$/MO`**

In `statBand1` (around line 230), change the spend stat's label from `"EST. SPEND"` to `"EST. $/MO"`:

```tsx
        statHtml(spendUsd != null ? compactUsd(spendUsd)             : "-", "EST. $/MO", GREEN, { size: 60, marginRight: 0 }),
```

- [ ] **Step 4: Make the footer carry the provenance jab**

Find the footer line (around line 247):

```tsx
    const footer = footerHtml("COMPILED FROM LOCAL TRANSCRIPTS");
```

replace with:

```tsx
    const footer = footerHtml("MEASURED FROM LOCAL TRANSCRIPTS · NOT A SCREENSHOT");
```

- [ ] **Step 5: Bump the OG render revision so caches refresh**

Open `apps/site/functions/_lib/og-meta.ts`, find `OG_RENDER_REV`, and increment its numeric value by 1 (e.g. `7` → `8`). This is the cache-key bump the OG template-change convention requires (see the OG satori quirks note).

- [ ] **Step 6: Verify the build succeeds**

Run: `cd apps/site && bun run build`
Expected: build succeeds, no TS error in `og-profile/[login].ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/site/functions/og-profile/\[login\].ts apps/site/functions/_lib/og-meta.ts
git commit -m "feat(site): OG card leads measured \$/mo + provenance"
```

---

### Task 6: Visual verification

**Files:** none (verification only)

- [ ] **Step 1: Build and preview**

Run: `cd apps/site && bun run build && bun run preview` (or the project's site dev command).
Open `/u/necmttn` (or any registered login). Confirm:
- Hero shows `~$<n>/mo` in green at the top, with the `measured from N sessions over Wd · not a screenshot` subline.
- Stat row reads `models · skills · sessions`.
- The old `est. spend` vital is gone from the ledger (no duplicate spend figure).

- [ ] **Step 2: Verify the OG card**

Fetch `/og-profile/necmttn.png` (the OG image route) and confirm the green hero numeral reads `~$<n>/mo` with the `EST. $/MO` label and the `MEASURED … NOT A SCREENSHOT` footer. Verify the rendered number matches `ax profile show` monthly-normalised spend for the same login (figures must match real output - do not trust the mock).

- [ ] **Step 3: Verify the --no-cost path**

Against a `--no-cost` fixture/profile (no `stats.cost_usd`), confirm the hero falls back to leading with `sessions` and renders no `$/mo` slot, and the OG spend stat shows `-`.

---

## Self-Review

**Spec coverage (Stage 1 of the design doc):**
- `$/mo` mirror-and-beat headline + provenance subline → Task 1 (derive), Task 2 (render).
- Stat row (`$/mo · models · skills · sessions`; `tools` → `skills`, since ax has no product-level "tools" concept - the rig-surface count is skills) → Task 2.
- Promote `est. spend` into the hero / remove the mid-page duplicate → Task 2 Step 3.
- `--no-cost` reads correctly → Task 1 test + Task 2 fallback + Task 6 Step 3.
- OG card mirrors the headline → Tasks 4-5; cache bump Task 5 Step 5; figure verified against real output Task 6 Step 2.
- **Deferred to Stage 1.1 (not this plan):** derived `stack-choice` tool takes (no data source - `taste.ts` defers it) and optional manual `rig.skills[].note` override (new input + schema + publish). Stated in the plan header.

**Placeholder scan:** none - every code step carries complete code; commands have expected output.

**Type consistency:** `monthlyUsd`/`buildHero`/`Hero` (Task 1) match their use in Task 2; `perMonthUsd` (Task 4) matches its use in Task 5; `fmtMoney`/`fmtInt`/`Vital` are pre-existing in `u.$login.tsx`. `ProfileV1` (site `~/lib/community`) is the type both the route and the OG function already use.
