# Challenge share-card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a published ax profile into a paste-able pairwise duel - canonical `/u/<a>/vs/<b>` link, unclaimed-challenger "fight back" state, a duel OG unfurl image, a louder challenge+share block on every profile page, and a CLI publish hint. Zero team infrastructure.

**Architecture:** Reuse the existing `?vs=` comparison machinery in `apps/site/app/routes/u.$login.tsx`. Extract the big `ProfileDossier` render tree into a shared component so a thin new path-route can preset the vs peer without forking render logic. Add a sibling Cloudflare Pages Function for the duel OG image (satori - stat ledgers + a lead tally, no radar since satori can't draw SVG). Add one CLI print line.

**Tech Stack:** TanStack Start (file routes, SPA), React 19, `workers-og` (satori) Pages Functions, Effect-based axctl CLI, `bun:test`.

---

## Spec

`docs/superpowers/plans/../specs/2026-06-16-challenge-share-card-design.md` (in this worktree at `docs/superpowers/specs/2026-06-16-challenge-share-card-design.md`).

## Grounding facts (verified against the worktree)

- Comparison already exists: `u.$login.tsx` reads `?vs=<login>` (`validateSearch`, `LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/`), fetches the peer, overlays both on `RadarChart`, and renders `RawTable` with a per-axis leader rule (`u.$login.tsx:548-550`: `aLeads = a.value !== null && (b.value === null || a.value > b.value)`).
- `ProfileDossier` (`u.$login.tsx:174`) is the whole page body; `SignSection` (`:389`) holds the compare form (`pf-sign-compare`, `:451`) and `RawTable` (`:517`). `UnclaimedDossier` (`:933`). `VisitorCTA` (`:955`).
- Radar helpers: `apps/site/app/lib/radar.ts` exports `RADAR_AXES_META`, `RADAR_AXIS_KEYS`, `RadarAxes`, `AxisRaw` (`{ value: number|null; label: string }`), `profileToAxes(p)`.
- OG infra: `apps/site/functions/og-profile/[login].ts` (registration→gist fetch, satori HTML, `workers-og` `ImageResponse`). Shared kit `functions/_lib/og-kit.ts` (`INK,PAPER,DIM,CARD,GREEN,RED,BLUE`, `esc`, `statHtml`, `footerHtml`, `blockLogoHtml`, `compactNumber`, `compactUsd`, `loadOgFonts`). `functions/_lib/og-meta.ts` (`OG_PROFILE_RENDER_REV = 1`, `buildProfileOgImageUrl(login)`).
- CLI publish prints URLs at `apps/axctl/src/cli/commands/profile.ts:266-268` (first publish) and `:290-292` (update).
- Site is effect-free; community validation is manual in `apps/site/app/lib/community.ts`.
- Satori rules (top of `og-profile/[login].ts`): `display:flex` everywhere, integer px, `margin-right` not `gap`, no `overflow`/`border-radius` on tracks, no raw svg, hex colors only, no `flex-wrap`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/site/app/lib/radar.ts` (modify) | add pure `leadTally(self, vs)` helper + `LeadTally` type |
| `apps/site/app/components/profile-dossier.tsx` (create) | extracted `ProfileDossier` + all its sub-components & helpers, moved verbatim from `u.$login.tsx`; new `UnclaimedChallenger`; new `ChallengeShareBlock` |
| `apps/site/app/routes/u.$login.tsx` (modify) | thin: state fetch + render `<ProfileDossier>`; imports from the component module |
| `apps/site/app/routes/u.$login.vs.$other.tsx` (create) | thin path-route: validate params, self-redirect, render dossier with vs preset |
| `apps/site/app/lib/challenge.ts` (create) | pure `compareDecision(a, b)` (redirect-vs-overlay) + `duelXIntent(...)` URL builders |
| `apps/site/functions/og-duel/[a]/[b].ts` (create) | duel OG image: two ledgers + lead tally, no radar |
| `apps/site/functions/_lib/og-meta.ts` (modify) | `OG_DUEL_RENDER_REV` + `buildDuelOgImageUrl(a, b)` |
| `apps/axctl/src/cli/commands/profile.ts` (modify) | hint line after publish/update URL block |

> **Worktree:** all work happens in `.claude/worktrees/challenge-share-card` (branch `feat/challenge-share-card`). Run every command from there.
> **bun:test hook:** a global hook blocks bare `bun test`. If blocked, run via a tmp wrapper script (see memory `test_runner`); the plan writes `bun test <file>` commands assuming the wrapper or an allowed invocation.
> **Site typecheck** is strict-null and needs a prior build (route/content codegen). Adding a route file requires regenerating `routeTree.gen.ts` - run `bun run --filter @ax/site build` (or the site dev server once) before typecheck.

---

### Task 1: `leadTally` pure helper in radar.ts

**Files:**
- Modify: `apps/site/app/lib/radar.ts`
- Test: `apps/site/app/lib/radar.test.ts` (create if absent; else append)

- [ ] **Step 1: Write the failing test**

Append to `apps/site/app/lib/radar.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { leadTally, RADAR_AXIS_KEYS, type RadarAxes } from "./radar";

// minimal RadarAxes builder: every axis gets {value,label}; scores/raws only
function axesWith(values: ReadonlyArray<number | null>): RadarAxes {
    const raws = {} as RadarAxes["raws"];
    const scores = {} as RadarAxes["scores"];
    RADAR_AXIS_KEYS.forEach((k, i) => {
        const v = values[i] ?? null;
        raws[k] = { value: v, label: v === null ? "-" : String(v) };
        scores[k] = v ?? 0;
    });
    return { scores, raws, partial: false };
}

describe("leadTally", () => {
    it("counts strictly-greater per-axis wins for each side", () => {
        const a = axesWith([10, 5, 8, 3, 9, 1]);
        const b = axesWith([2, 5, 12, 4, 1, 0]);
        // a wins axes 0,4,5 ; b wins axes 2,3 ; axis 1 is a tie (no lead)
        const t = leadTally(a, b);
        expect(t.aLeads).toBe(3);
        expect(t.bLeads).toBe(2);
        expect(t.total).toBe(RADAR_AXIS_KEYS.length);
    });

    it("null never leads; a non-null beats a null", () => {
        const a = axesWith([5, null, null, null, null, null]);
        const b = axesWith([null, 7, null, null, null, null]);
        const t = leadTally(a, b);
        expect(t.aLeads).toBe(1); // axis0: 5 > null
        expect(t.bLeads).toBe(1); // axis1: 7 > null
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/site/app/lib/radar.test.ts`
Expected: FAIL - `leadTally` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `apps/site/app/lib/radar.ts` (mirrors the `RawTable` leader rule at `u.$login.tsx:548-550`):

```ts
export interface LeadTally {
    readonly aLeads: number;
    readonly bLeads: number;
    readonly total: number;
}

/**
 * Per-axis "who leads" tally between two profiles. Strictly-greater comparable
 * value wins; null never leads; equal values produce no lead for either side.
 * Single source of truth for the page's RawTable dots and the duel OG tally.
 */
export function leadTally(a: RadarAxes, b: RadarAxes): LeadTally {
    let aLeads = 0;
    let bLeads = 0;
    for (const k of RADAR_AXIS_KEYS) {
        const av = a.raws[k].value;
        const bv = b.raws[k].value;
        if (av !== null && (bv === null || av > bv)) aLeads++;
        else if (bv !== null && (av === null || bv > av)) bLeads++;
    }
    return { aLeads, bLeads, total: RADAR_AXIS_KEYS.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/site/app/lib/radar.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add apps/site/app/lib/radar.ts apps/site/app/lib/radar.test.ts
git commit -m "feat(site): leadTally per-axis who-leads helper"
```

---

### Task 2: Extract `ProfileDossier` into a shared component module

This is a **pure move** (no behavior change) so the new path-route can render the same body. Verify by build + existing route still works.

**Files:**
- Create: `apps/site/app/components/profile-dossier.tsx`
- Modify: `apps/site/app/routes/u.$login.tsx`

- [ ] **Step 1: Create the component module**

Create `apps/site/app/components/profile-dossier.tsx`. Move - verbatim - from `u.$login.tsx`: the constants `SELF_COLOR`, `VS_COLOR`, `LOGIN_RE`, all formatting helpers (`COMPACT`…`clampPct`), `type VsState`, and the components/helpers `ProfileDossier`, `Vital`, `Kicker`, `SignSection`, `ScoreList`, `RawTable`, `fmtScore`, `StackedWindow`, `tooltipText`, `WindowTooltip`, `SkillRow`, `InsightCard`, `VizBar`, `VizTicks`, `VizRail`, `buildInsightCards`, `SkillGroup`, `groupSkills`, `UnclaimedDossier`, `VisitorCTA`. Keep all imports they need (`radar`, `community`, `window-chart`, `dossier-card-art`, `radar-chart`, TanStack `Link`/`useNavigate`, React). Export `ProfileDossier`, `VsState`, `LOGIN_RE`, `UnclaimedDossier`, `SignSection` (the route needs `ProfileDossier`, `VsState`, `LOGIN_RE`, `UnclaimedDossier`).

- [ ] **Step 2: Slim the route to import from the module**

Edit `apps/site/app/routes/u.$login.tsx` to keep only: the `Route` definition (`validateSearch`, `head`, `component: ProfilePage`), `type State`, and `ProfilePage` (the loader/fetch state machine). Replace the moved definitions with:

```ts
import { ProfileDossier, UnclaimedDossier, LOGIN_RE, type VsState } from "~/components/profile-dossier";
```

Delete the now-duplicated `LOGIN_RE`, `SELF_COLOR`, `VS_COLOR`, `type VsState`, and all moved components from the route file. `ProfilePage` still owns `State`/`VsState` fetch effects and renders `<ProfileDossier profile={…} vs={vsState} />` / `<UnclaimedDossier login={…} />` exactly as before.

- [ ] **Step 3: Build (regenerates routeTree) and typecheck**

Run: `bun run --filter @ax/site build`
Expected: build succeeds, no TS errors. (If `bun --filter` is broken in this repo per memory, run the site build from `apps/site`: `bun run build` in that dir.)

- [ ] **Step 4: Smoke the existing route**

Run the site dev server, open `/u/necmttn` and `/u/necmttn?vs=supnim`.
Expected: identical to before the extraction (dossier renders, overlay works).

- [ ] **Step 5: Commit**

```bash
git add apps/site/app/components/profile-dossier.tsx apps/site/app/routes/u.$login.tsx
git commit -m "refactor(site): extract ProfileDossier into shared component"
```

---

### Task 3: `compareDecision` helper + canonical `/u/<a>/vs/<b>` route

**Files:**
- Create: `apps/site/app/lib/challenge.ts`
- Test: `apps/site/app/lib/challenge.test.ts`
- Create: `apps/site/app/routes/u.$login.vs.$other.tsx`

- [ ] **Step 1: Write the failing test for the pure decision**

Create `apps/site/app/lib/challenge.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { compareDecision, duelPath, duelXIntent } from "./challenge";

describe("compareDecision", () => {
    it("rejects a bad login", () => {
        expect(compareDecision("ok", "bad handle!").kind).toBe("invalid");
    });
    it("redirects self-compare (case-insensitive) to the plain profile", () => {
        const d = compareDecision("Necmttn", "necmttn");
        expect(d).toEqual({ kind: "redirect", to: "/u/Necmttn" });
    });
    it("overlays two distinct valid logins", () => {
        const d = compareDecision("a", "b");
        expect(d).toEqual({ kind: "overlay", a: "a", b: "b" });
    });
});

describe("url builders", () => {
    it("duelPath", () => {
        expect(duelPath("a", "b")).toBe("/u/a/vs/b");
    });
    it("duelXIntent embeds the lead line and absolute url", () => {
        const url = duelXIntent({ a: "a", b: "b", aLeads: 4, bLeads: 2, origin: "https://ax.necmttn.com" });
        expect(url).toContain("https://twitter.com/intent/tweet");
        expect(decodeURIComponent(url)).toContain("@a leads @b on 4 of 6 axes");
        expect(decodeURIComponent(url)).toContain("https://ax.necmttn.com/u/a/vs/b");
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/site/app/lib/challenge.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement `challenge.ts`**

```ts
// apps/site/app/lib/challenge.ts
// Pure challenge/duel helpers - no React, no fetch, unit-testable.

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

export type CompareDecision =
    | { kind: "invalid" }
    | { kind: "redirect"; to: string }
    | { kind: "overlay"; a: string; b: string };

/** Decide what /u/<a>/vs/<b> should do: reject bad logins, redirect self-compare,
 *  else overlay. Keeps the route component a thin renderer. */
export function compareDecision(a: string, b: string): CompareDecision {
    if (!LOGIN_RE.test(a) || !LOGIN_RE.test(b)) return { kind: "invalid" };
    if (a.toLowerCase() === b.toLowerCase()) return { kind: "redirect", to: `/u/${a}` };
    return { kind: "overlay", a, b };
}

export const duelPath = (a: string, b: string): string => `/u/${a}/vs/${b}`;

export interface DuelXIntentArgs {
    readonly a: string;
    readonly b: string;
    readonly aLeads: number;
    readonly bLeads: number;
    readonly total?: number;
    readonly origin: string;
}

/** X (twitter) web-intent URL prefilled with the lead line + absolute duel link. */
export function duelXIntent({ a, b, aLeads, total = 6, origin }: DuelXIntentArgs): string {
    const text = `@${a} leads @${b} on ${aLeads} of ${total} axes - think you can beat us?`;
    const url = `${origin}${duelPath(a, b)}`;
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/site/app/lib/challenge.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the route**

Create `apps/site/app/routes/u.$login.vs.$other.tsx`:

```tsx
// apps/site/app/routes/u.$login.vs.$other.tsx
// Canonical, shareable head-to-head duel: /u/<a>/vs/<b>.
// Thin wrapper over ProfileDossier - presets the vs peer, reuses the overlay.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteHeader } from "~/components/landing-sections/site-header";
import { SiteFooter } from "~/components/landing-sections/site-footer";
import { ProfileDossier, UnclaimedDossier, type VsState } from "~/components/profile-dossier";
import { fetchProfile, type ProfileV1 } from "~/lib/community";
import { compareDecision } from "~/lib/challenge";
import { buildDuelOgImageUrl } from "~/../functions/_lib/og-meta"; // see note below

export const Route = createFileRoute("/u/$login/vs/$other")({
    beforeLoad: ({ params }) => {
        const d = compareDecision(params.login, params.other);
        if (d.kind === "redirect") throw redirect({ to: d.to });
        // invalid logins fall through to the not-found render in the component
    },
    head: ({ params }) => ({
        meta: [
            { title: `@${params.login} vs @${params.other} - ax duel` },
            { name: "description", content: `Agent profile duel: @${params.login} vs @${params.other}, compiled from the ax graph.` },
            { property: "og:image", content: buildDuelOgImageUrl(params.login, params.other) },
            { name: "twitter:card", content: "summary_large_image" },
            { name: "twitter:image", content: buildDuelOgImageUrl(params.login, params.other) },
        ],
    }),
    component: DuelPage,
});

type State =
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error"; message: string }
    | { kind: "ready"; profile: ProfileV1 };

function DuelPage() {
    const { login, other } = Route.useParams();
    const [state, setState] = useState<State>({ kind: "loading" });
    const [vsState, setVsState] = useState<VsState>({ kind: "none" });

    // primary subject (a)
    useEffect(() => {
        let alive = true;
        setState({ kind: "loading" });
        fetchProfile(login)
            .then((profile) => {
                if (!alive) return;
                if (profile.github.toLowerCase() !== login.toLowerCase()) {
                    setState({ kind: "error", message: "profile identity mismatch" });
                    return;
                }
                setState({ kind: "ready", profile });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setState(notFound ? { kind: "not-found" } : { kind: "error", message: e instanceof Error ? e.message : String(e) });
            });
        return () => { alive = false; };
    }, [login]);

    // challenger (b) -> vs overlay or unclaimed-challenger note
    useEffect(() => {
        let alive = true;
        setVsState({ kind: "loading", login: other });
        fetchProfile(other)
            .then((profile) => {
                if (!alive) return;
                if (profile.github.toLowerCase() !== other.toLowerCase()) {
                    setVsState({ kind: "error", login: other });
                    return;
                }
                setVsState({ kind: "ready", login: other, profile });
            })
            .catch((e: unknown) => {
                if (!alive) return;
                const notFound = typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;
                setVsState(notFound ? { kind: "not-found", login: other } : { kind: "error", login: other });
            });
        return () => { alive = false; };
    }, [other]);

    return (
        <>
            <SiteHeader />
            <main className="profile-page">
                {state.kind === "loading" && <p className="pf-loading">pulling the duel @{login} vs @{other}…</p>}
                {state.kind === "not-found" && <UnclaimedDossier login={login} />}
                {state.kind === "error" && <p className="pf-loading">couldn't load profile: {state.message}</p>}
                {state.kind === "ready" && <ProfileDossier profile={state.profile} vs={vsState} />}
            </main>
            <SiteFooter />
        </>
    );
}
```

> **Import note:** if `~/../functions/...` does not resolve under the site's tsconfig paths, instead duplicate the tiny `buildDuelOgImageUrl` into `apps/site/app/lib/challenge.ts` and import it from there. Decide at implementation time by trying the build; keep ONE definition. (Task 6 defines the canonical copy in `functions/_lib/og-meta.ts`; if the route can't import it, re-export it from `challenge.ts`.)

- [ ] **Step 6: Build + smoke**

Run: `bun run --filter @ax/site build` then open:
- `/u/necmttn/vs/supnim` → overlay (both render, RawTable dots).
- `/u/necmttn/vs/necmttn` → redirects to `/u/necmttn`.
- `/u/necmttn/vs/ghost-handle` → necmttn dossier + unclaimed vs note (Task 4 finishes the note styling).

Expected: routes resolve; redirect works.

- [ ] **Step 7: Commit**

```bash
git add apps/site/app/lib/challenge.ts apps/site/app/lib/challenge.test.ts apps/site/app/routes/u.\$login.vs.\$other.tsx apps/site/app/routeTree.gen.ts
git commit -m "feat(site): canonical /u/<a>/vs/<b> duel route + compareDecision"
```

---

### Task 4: `UnclaimedChallenger` vs-state in `SignSection`

When the challenger `b` is unregistered, the sign section should read as a dare instead of a silent empty overlay. The existing `SignSection` already shows `vs.kind === "not-found"` as a small message (`u.$login.tsx:474`). Promote that to a stamped note + publish command.

**Files:**
- Modify: `apps/site/app/components/profile-dossier.tsx`

- [ ] **Step 1: Add the `UnclaimedChallenger` note component**

In `profile-dossier.tsx`, add near `UnclaimedDossier`:

```tsx
/** Shown inside SignSection when the challenger b is unregistered: a dare, not
 *  an error. Reuses the unclaimed stamp/copy styling. */
function UnclaimedChallenger({ login }: { login: string }) {
    return (
        <div className="pf-challenge-unclaimed">
            <span className="pf-challenge-stamp" aria-hidden="true">unanswered</span>
            <p className="pf-challenge-line">
                challenge issued · <strong>@{login}</strong> hasn't published a dossier yet.
            </p>
            <code className="pf-empty-cmd">ax profile publish</code>
            <span className="pf-challenge-sub">one command answers the challenge - their transcripts never leave their machine.</span>
        </div>
    );
}
```

- [ ] **Step 2: Render it from `SignSection`**

In `SignSection`, replace the bare `{vs.kind === "not-found" && <span …>}` line with:

```tsx
{vs.kind === "not-found" && <UnclaimedChallenger login={vs.login} />}
```

(keep the `loading` and `error` `pf-sign-msg` spans as-is).

- [ ] **Step 3: Add styles**

Append to the profile stylesheet (find where `.pf-empty-stamp` / `.pf-sign-msg` live - `rg -l "pf-empty-stamp" apps/site/app/styles`). Add:

```css
.pf-challenge-unclaimed { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; padding: 16px; border: 1px dashed var(--line, #33364a); position: relative; }
.pf-challenge-stamp { align-self: flex-start; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--red, #f87171); border: 1px solid currentColor; padding: 2px 8px; }
.pf-challenge-line { margin: 0; }
.pf-challenge-sub { font-size: 13px; color: var(--dim, #8b93a1); }
```

- [ ] **Step 4: Build + smoke**

Run: `bun run --filter @ax/site build`, open `/u/necmttn/vs/ghost-handle`.
Expected: necmttn's full dossier; the sign section shows the "unanswered" stamp + publish command instead of a one-line message.

- [ ] **Step 5: Commit**

```bash
git add apps/site/app/components/profile-dossier.tsx apps/site/app/styles
git commit -m "feat(site): unclaimed-challenger dare in the sign section"
```

---

### Task 5: Challenge + share block on every profile page

Promote the quiet compare form into a louder standalone block, and when a comparison is active add copy-link + post-on-X buttons. Implemented inside `SignSection` (it already owns the compare form, the `vs` state, and-via `RawTable`-both axes).

**Files:**
- Modify: `apps/site/app/components/profile-dossier.tsx`

- [ ] **Step 1: Compute the lead tally + duel URL in `SignSection`**

At the top of `SignSection`, after `vsAxes` is computed, add:

```tsx
import { leadTally } from "~/lib/radar";
import { duelPath, duelXIntent } from "~/lib/challenge";
// ...inside SignSection, where selfAxes/vsAxes exist:
const tally = vsReady && vsAxes ? leadTally(selfAxes, vsAxes) : null;
const origin = typeof window !== "undefined" ? window.location.origin : "https://ax.necmttn.com";
const duelUrl = vsReady ? `${origin}${duelPath(profile.github, vsReady.login)}` : "";
const [copied, setCopied] = useState(false);
const copyDuel = () => {
    if (!duelUrl) return;
    void navigator.clipboard?.writeText(duelUrl).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
    });
};
```

- [ ] **Step 2: Promote the prompt copy + add share buttons**

In the `pf-sign-compare` block: change the form label from `compare with` to a louder prompt, and when `vsReady` render the share row. Replace the compare-control JSX with:

```tsx
<div className="pf-sign-compare">
    {vsReady ? (
        <div className="pf-share-row">
            <button type="button" className="pf-share-btn" onClick={copyDuel}>
                {copied ? "copied ✓" : "copy duel link"}
            </button>
            {tally && (
                <a
                    className="pf-share-btn"
                    href={duelXIntent({ a: profile.github, b: vsReady.login, aLeads: tally.aLeads, bLeads: tally.bLeads, total: tally.total, origin })}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    post on X
                </a>
            )}
            <button type="button" className="pf-sign-clear" onClick={clearCompare}>clear</button>
        </div>
    ) : (
        <form className="pf-sign-form" onSubmit={submit}>
            <span className="pf-sign-form-label">Think you out-ship @{profile.github}?</span>
            <input
                className="pf-sign-input"
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                placeholder="github handle"
                aria-label="github handle to challenge"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
            />
            <button type="submit" className="pf-sign-go">challenge →</button>
        </form>
    )}
    {vs.kind === "loading" && <span className="pf-sign-msg">pulling @{vs.login}…</span>}
    {vs.kind === "error" && <span className="pf-sign-msg">couldn't load @{vs.login}.</span>}
</div>
```

> Note: `submit` currently calls `navigate({ search: { vs: target } })` (query form). Keep it - the on-page overlay stays query-based; the canonical path link is what `copy duel link` emits. This avoids a full navigation on every keystroke-submit while still producing the shareable path URL.

- [ ] **Step 3: Add styles**

```css
.pf-share-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pf-share-btn { font: inherit; font-size: 13px; padding: 6px 12px; border: 1px solid var(--green, #34d399); color: var(--green, #34d399); background: transparent; cursor: pointer; text-decoration: none; }
.pf-share-btn:hover { background: color-mix(in srgb, var(--green, #34d399) 12%, transparent); }
```

- [ ] **Step 4: Build + smoke**

Run: `bun run --filter @ax/site build`, open `/u/necmttn`.
Expected: the prompt reads "Think you out-ship @necmttn?" with a "challenge →" button. After overlaying a peer, "copy duel link" / "post on X" / "clear" appear; copy puts `https://…/u/necmttn/vs/<peer>` on the clipboard.

- [ ] **Step 5: Commit**

```bash
git add apps/site/app/components/profile-dossier.tsx apps/site/app/styles
git commit -m "feat(site): louder challenge prompt + copy-link/post-on-X share"
```

---

### Task 6: Duel OG image function + URL helper

**Files:**
- Modify: `apps/site/functions/_lib/og-meta.ts`
- Create: `apps/site/functions/og-duel/[a]/[b].ts`
- Test: `apps/site/functions/_lib/og-meta.test.ts` (append)

- [ ] **Step 1: Write the failing test for the URL helper**

Append to `apps/site/functions/_lib/og-meta.test.ts`:

```ts
import { buildDuelOgImageUrl, OG_DUEL_RENDER_REV } from "./og-meta";

describe("buildDuelOgImageUrl", () => {
    it("builds the duel og path with both logins and a render rev", () => {
        const url = buildDuelOgImageUrl("a", "b");
        expect(url).toContain("/og-duel/a/b");
        expect(url).toContain(`r=${OG_DUEL_RENDER_REV}`);
    });
});
```

(If `og-meta.test.ts` lacks a `describe` import, add `import { describe, expect, it } from "bun:test";`.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/site/functions/_lib/og-meta.test.ts`
Expected: FAIL - `buildDuelOgImageUrl` not exported.

- [ ] **Step 3: Add the helper**

Append to `apps/site/functions/_lib/og-meta.ts` (mirror `buildProfileOgImageUrl` at `:45`):

```ts
export const OG_DUEL_RENDER_REV = 1;

export const buildDuelOgImageUrl = (a: string, b: string): string =>
    `https://ax.necmttn.com/og-duel/${a}/${b}?r=${OG_DUEL_RENDER_REV}`;
```

(Match the exact origin/format used by `buildProfileOgImageUrl` - open the file and copy its style; if it uses a relative path or different host, follow that.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test apps/site/functions/_lib/og-meta.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the duel OG function**

Create `apps/site/functions/og-duel/[a]/[b].ts`. Reuse the registration→gist fetch from `og-profile/[login].ts` (copy `LOGIN_RE`, `REPO_RAW`, the `Registration`/`ProfileV1`/`ProfileStats` interfaces, and a small `loadProfile(login)` extracted from its Path B). Layout: two columns side by side, each `@login` + a 3-stat mini-ledger (sessions / tokens / spend via `statHtml`,`compactNumber`,`compactUsd`), a center "VS", and a bottom lead-tally line. **No radar.** Lead tally is computed from the two profiles' axes - but `profileToAxes` lives in `app/lib/radar.ts` (app side), and Pages Functions can't import app code freely; compute a *coarse* tally here from the same raw stats the ledger shows (sessions/tokens/spend/streak/hours/commits - whichever both expose), counting strictly-greater wins. Keep it labeled "axes lead" only if you wire the real `RadarAxes`; otherwise label it "stats lead". Pick the stats-lead variant for v1 to stay self-contained:

```ts
// apps/site/functions/og-duel/[a]/[b].ts
import { ImageResponse } from "workers-og";
import { OG_DUEL_RENDER_REV } from "../../_lib/og-meta";
import { INK, DIM, CARD, GREEN, BLUE, PAPER, esc, statHtml, footerHtml, blockLogoHtml, compactNumber, compactUsd, loadOgFonts } from "../../_lib/og-kit";

const LOGIN_RE = /^[A-Za-z0-9_-]{1,39}$/;
const REPO_RAW = "https://raw.githubusercontent.com/Necmttn/ax/main";

interface ProfileLite {
    readonly github: string;
    readonly sessions: number | null;
    readonly tokens: number | null;
    readonly spendUsd: number | null;
    readonly streakDays: number | null;
    readonly registered: boolean;
}

async function loadProfile(login: string): Promise<ProfileLite> {
    const empty: ProfileLite = { github: login, sessions: null, tokens: null, spendUsd: null, streakDays: null, registered: false };
    try {
        const regRes = await fetch(`${REPO_RAW}/community/users/${login.toLowerCase()}.json`, { headers: { "user-agent": "ax-og-duel" } });
        if (!regRes.ok) return empty;
        const reg = (await regRes.json()) as { gist_id?: string; github?: string };
        if (typeof reg.gist_id !== "string" || typeof reg.github !== "string") return empty;
        const pRes = await fetch(`https://gist.githubusercontent.com/${reg.github}/${reg.gist_id}/raw/ax-profile.json`, { headers: { "user-agent": "ax-og-duel" } });
        if (!pRes.ok) return empty;
        const p = (await pRes.json()) as { v?: number; github?: string; stats?: { sessions?: number; streak_days?: number; tokens?: { total?: number }; cost_usd?: number } };
        if (p.v !== 1 || !p.stats) return empty;
        return {
            github: typeof p.github === "string" ? p.github : login,
            sessions: p.stats.sessions ?? null,
            tokens: p.stats.tokens?.total ?? null,
            spendUsd: p.stats.cost_usd ?? null,
            streakDays: p.stats.streak_days ?? null,
            registered: true,
        };
    } catch { return empty; }
}

/** strictly-greater wins across the comparable numeric stats both sides expose. */
function statsLead(a: ProfileLite, b: ProfileLite): { aLeads: number; bLeads: number; total: number } {
    const keys: ReadonlyArray<keyof ProfileLite> = ["sessions", "tokens", "spendUsd", "streakDays"];
    let aLeads = 0, bLeads = 0, total = 0;
    for (const k of keys) {
        const av = a[k] as number | null;
        const bv = b[k] as number | null;
        if (av === null && bv === null) continue;
        total++;
        if (av !== null && (bv === null || av > bv)) aLeads++;
        else if (bv !== null && (av === null || bv > av)) bLeads++;
    }
    return { aLeads, bLeads, total };
}

function ledgerHtml(p: ProfileLite, accent: string): string {
    const handle = `<div style="display:flex;align-items:baseline"><span style="font-size:40px;font-weight:700;color:${accent};font-family:'Gelasio';margin-right:2px">@</span><span style="font-size:56px;font-weight:700;color:${INK};font-family:'Gelasio';line-height:1">${esc(p.github)}</span></div>`;
    if (!p.registered) {
        return `<div style="display:flex;flex-direction:column;width:480px">${handle}<span style="font-size:18px;color:${DIM};margin-top:24px">unclaimed - challenge unanswered</span></div>`;
    }
    const stats = `<div style="display:flex;justify-content:space-between;margin-top:32px">${[
        statHtml(p.sessions != null ? p.sessions.toLocaleString("en-US") : "-", "SESSIONS", INK, { marginRight: 0 }),
        statHtml(p.tokens != null ? compactNumber(p.tokens) : "-", "TOKENS", INK, { marginRight: 0 }),
        statHtml(p.spendUsd != null ? compactUsd(p.spendUsd) : "-", "SPEND", accent, { marginRight: 0 }),
    ].join("")}</div>`;
    return `<div style="display:flex;flex-direction:column;width:480px">${handle}${stats}</div>`;
}

export const onRequestGet: PagesFunction = async (ctx) => {
    const a = String(ctx.params.a ?? "").replace(/\.png$/, "");
    const b = String(ctx.params.b ?? "").replace(/\.png$/, "");
    if (!LOGIN_RE.test(a) || !LOGIN_RE.test(b)) return new Response("bad request", { status: 400 });

    const cache = (caches as unknown as { default: Cache }).default;
    const u = new URL(ctx.request.url);
    u.searchParams.set("rev", String(OG_DUEL_RENDER_REV));
    const cacheKey = new Request(u.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const [pa, pb] = await Promise.all([loadProfile(a), loadProfile(b)]);
    const tally = statsLead(pa, pb);

    const header = `<div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex">${blockLogoHtml({ scale: 5, color: PAPER, dimColor: "transparent" })}</div><span style="font-size:13px;letter-spacing:2px;color:${DIM}">AGENT DUEL · LAST 30 DAYS</span></div>`;
    const arena = `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:48px">${ledgerHtml(pa, GREEN)}<span style="display:flex;font-size:48px;font-weight:700;color:${DIM};font-family:'Gelasio'">vs</span>${ledgerHtml(pb, BLUE)}</div>`;
    const leadLine = tally.total > 0
        ? `<div style="display:flex;margin-top:44px"><span style="font-size:20px;color:${DIM}"><span style="color:${GREEN}">@${esc(a)}</span> leads ${tally.aLeads} of ${tally.total} · <span style="color:${BLUE}">@${esc(b)}</span> leads ${tally.bLeads} of ${tally.total}</span></div>`
        : "";
    const footer = footerHtml("COMPILED FROM LOCAL TRANSCRIPTS");
    const inner = `<div style="display:flex;flex-direction:column">${header}${arena}${leadLine}</div>`;
    const html = `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background:${CARD};padding:56px 64px;font-family:'JetBrains Mono'">${inner}${footer}</div>`;

    const { regular, bold, serif } = await loadOgFonts();
    let png: ArrayBuffer;
    try {
        const image = new ImageResponse(html, {
            width: 1200, height: 630,
            fonts: [
                { name: "JetBrains Mono", data: regular, weight: 400, style: "normal" },
                { name: "JetBrains Mono", data: bold, weight: 700, style: "normal" },
                { name: "Gelasio", data: serif, weight: 700, style: "normal" },
            ],
        });
        png = await image.arrayBuffer();
    } catch (err) {
        return new Response(`render error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
    }
    if (png.byteLength === 0) return new Response("render produced 0 bytes", { status: 500 });

    const res = new Response(png, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600, s-maxage=3600" } });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
};
```

> The spec said "no radar; stat bars + lead tally" - this uses a stats-lead tally (self-contained in the function), not the 6-axis radar tally. That is the intended v1 (the function can't cheaply import app-side `profileToAxes`). The label reads "leads N of {total}" where total is the count of comparable stats. Note this divergence from the page's 6-axis tally in the PR description.

- [ ] **Step 6: Build + smoke**

Run: `bun run --filter @ax/site build`, then with the Pages dev server hit `/og-duel/necmttn/supnim` and `/og-duel/necmttn/ghost-handle`.
Expected: a 1200×630 PNG; registered/registered shows both ledgers + lead line; unclaimed `b` shows "unclaimed - challenge unanswered".

- [ ] **Step 7: Commit**

```bash
git add apps/site/functions/og-duel apps/site/functions/_lib/og-meta.ts apps/site/functions/_lib/og-meta.test.ts
git commit -m "feat(site): duel OG image + buildDuelOgImageUrl"
```

---

### Task 7: CLI publish hint line

**Files:**
- Modify: `apps/axctl/src/cli/commands/profile.ts:266-268` and `:290-292`

- [ ] **Step 1: Add the hint after first-publish URLs**

After `apps/axctl/src/cli/commands/profile.ts:268` (`short: …/@${ref.owner}`), add:

```ts
console.log(`challenge:  https://ax.necmttn.com/u/${ref.owner}/vs/<their-handle>`);
```

- [ ] **Step 2: Add the hint after update URLs**

After `:292` (`short:   …/@${state.owner}`), add:

```ts
console.log(`challenge: https://ax.necmttn.com/u/${state.owner}/vs/<their-handle>`);
```

(Align the label spacing with the surrounding `console.log` lines so the colon column lines up.)

- [ ] **Step 3: Typecheck axctl**

Run: `bun run --filter axctl typecheck` (or `bun run typecheck` from repo root).
Expected: no errors.

- [ ] **Step 4: Manual verify**

Inspect the two regions; confirm the hint prints `<their-handle>` literally (no network, no guess).

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/cli/commands/profile.ts
git commit -m "feat(cli): print challenge link hint after profile publish"
```

---

## Final verification

- [ ] Run the full site build: `bun run --filter @ax/site build` - clean.
- [ ] Run site typecheck (needs the build first): `bun run --filter @ax/site typecheck` - clean.
- [ ] Run repo tests for touched files: `bun test apps/site/app/lib/radar.test.ts apps/site/app/lib/challenge.test.ts apps/site/functions/_lib/og-meta.test.ts` - all pass.
- [ ] Run axctl typecheck: `bun run --filter axctl typecheck` - clean.
- [ ] Smoke all four URL shapes (overlay / self-redirect / unclaimed / og-duel) per the task steps.
- [ ] Open PR; in the description, note the **two intentional divergences**: (1) on-page tally is 6-axis radar lead, OG tally is coarse stats-lead (function can't import app-side `profileToAxes`); (2) on-page overlay stays `?vs=` query while the canonical shareable link is the `/u/<a>/vs/<b>` path.

## Self-review notes

- Spec §1 → Task 2 (extract) + Task 3 (route). §2 → Task 4. §3 → Task 7. §4 → Task 6. §5 → Task 5. All five components covered.
- Type consistency: `leadTally` (Task 1) returns `{aLeads,bLeads,total}` - same shape consumed in Task 5 and mirrored (as `statsLead`) in Task 6. `VsState`, `ProfileDossier`, `UnclaimedDossier` exported in Task 2, imported in Task 3. `compareDecision`/`duelPath`/`duelXIntent` defined Task 3, used Tasks 3 & 5. `buildDuelOgImageUrl`/`OG_DUEL_RENDER_REV` defined Task 6, used Task 3 (with the import-resolution fallback noted).
- No placeholders: every code step shows complete code; the one judgment call (cross-package import of `buildDuelOgImageUrl`) has an explicit resolve-at-build-time fallback.
