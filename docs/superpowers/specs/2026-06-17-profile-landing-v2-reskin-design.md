# Profile page → landing-v2 reskin

Date: 2026-06-17
Status: approved (design)
Surface: `apps/site` - `/u/$login` (and the `?vs=` compare overlay)

## Why

`/u/<login>` is the next marketing surface. The site landing was rebuilt in the
`landing-v2` visual language (animated hero, floating agent logos, warm-paper
shell, studio-ported wrapped cards). The profile still renders in the older
`pf-*` "dossier" idiom. This reskins the profile into the landing-v2 language and
brings the studio wrapped-card deck onto it, so a shared profile reads as part of
the same product.

## Scope

**Reskin, not rewrite.** All real data wiring stays intact:

- `fetchProfile(login)` → `ProfileV1` load + identity-binding guard (unchanged).
- `?vs=<login>` comparison overlay load + degrade-to-note (unchanged).
- Chart components reused as-is: `RadarChart`, `StackedWindow` + model legend,
  workflow arcs, leverage-sorted skills, guardrails, taste patterns.
- Data helpers reused: `~/lib/radar`, `~/lib/window-chart`, `~/lib/community`,
  `buildInsightCards`, `groupSkills`, `sortSkillsByLeverage`.

**What changes is the visual shell**: new CSS scope, hero treatment, section
rhythm, the insight-card chrome, and the CTA.

Out of scope: the OG share-card route, `s.$owner.$gistId`, `leaders.tsx`, any
data/schema/API change, the `ProfileV1` shape.

## Visual language

Adopt `.landing-v2` conventions, scoped under a new `.profile-v2` class applied
to `<main>` (mirrors how `index.tsx` applies `.landing-v2`):

- 1120px shell, `margin: 0 auto`, `padding: 0 32px`.
- Section intro = `.eyebrow` (mono, leading accent dot) + serif `h2`, matching
  landing `.demo-intro`.
- Warm-paper tokens already shared at `:root` (`--ink`, `--panel`, `--line`,
  `--muted`, `--green/blue/gold/violet/rose`). No new global tokens.
- The old `.profile-page` / `.pf-*` profile CSS block is removed after cutover.
  `leaders.tsx` keeps using the `.profile-page, .leaders-page` *base* rule - the
  base padding/width rule stays; only the `pf-*` profile-specific rules go. (If
  any `pf-*` rule is shared with leaders, it is duplicated into a leaders-only
  selector first.)

## Sections (top → bottom)

1. **Hero** - landing-v2 hero treatment.
   - `HeroLogoField` reused, but **filtered/dimmed to the user's actual
     harnesses** (`p.stats.harnesses`): harnesses the user runs render at full
     accent; the rest dim (or are omitted). Decorative, `aria-hidden`.
   - Eyebrow: `● live · {window_days}-day window · compiled {date}` (the `●` is
     the existing `pf-live-dot` pulse, ported).
   - Headline: big serif `@{github}` (landing `section.hero h1` scale).
   - Lede: the agent archetype one-liner (`archetypeFor(...).blurb`), so the hero
     says something true about the person, not boilerplate.
   - Vitals ledger folded in directly below the lede as a tight inline strip
     (sessions · tokens · est. spend · hrs in loop · days active · streak).

2. **The window** - `demo-intro` rhythm (eyebrow `the window` + `h2`), then the
   existing `StackedWindow` chart + model legend, restyled to landing card chrome.

3. **The shape of the work** - the **studio wrapped-card deck**.
   - New site component `WrappedDeck` (`apps/site/app/components/wrapped-deck.tsx`).
   - Card chrome ported from studio `wrapped-card`: accent-tinted strip header,
     `$ {question}` mono eyebrow (in accent), serif headline, muted body.
   - Accent rotates green → blue → gold → violet → rose by index.
   - **Grounded viz** kept: the existing per-card `viz` (`VizBar` / `VizTicks` /
     `VizRail`, real numbers from `ProfileInsights`) renders inside the strip
     header area, replacing studio's decorative bar-strip. Cards without a `viz`
     fall back to a quiet accent strip.
   - Fed by the existing `buildInsightCards(ins)`; `accent` field on a card may
     still pin a specific accent (e.g. `red` for failure-rate) - when present it
     overrides the rotation, matching today's behaviour.
   - `CardArt` is no longer rendered here. `dossier-card-art.tsx` is **retained**
     (reusable elsewhere) - only this call site drops it.

4. **The sign** - radar + archetype + `?vs=` compare, in landing card chrome.
   `RadarChart`, archetype read, compare form, score list, raw-values table - all
   reused; only container styling changes.

5. **The rig** - workflow arcs + leverage-sorted skills + guardrails, restyled to
   landing card chrome. Same data, same grouping.

6. **Taste** - patterns grid, restyled.

7. **CTA / colophon** - landing `footer-cards` numbered grid as the outward CTA
   (e.g. `01 Get ax → /docs/install`, `02 Publish yours`, `03 Leaders`,
   `04 Docs`) plus the existing `VisitorCTA` copy. `UnclaimedDossier` (the
   not-found state) restyled to match.

## Components

- `apps/site/app/routes/u.$login.tsx` - recomposed in landing-v2 idiom; data
  effects, state machine, and identity guard unchanged. Helper functions
  (`buildInsightCards`, `groupSkills`, formatters, `SignSection`, `RawTable`,
  etc.) kept; their JSX wrappers re-skinned.
- `apps/site/app/components/wrapped-deck.tsx` - new. Renders the insight-card
  deck in studio chrome with grounded viz + accent rotation. Owns its own
  `InsightCard` rendering; takes the card array as a prop so it is testable in
  isolation.
- `apps/site/app/styles/globals.css` - new `.profile-v2` block; remove the dead
  `pf-*` profile rules after cutover.

## Data flow

Unchanged. `ProfilePage` → `fetchProfile` → `ProfileV1`; `ProfileDossier`
(renamed conceptually to the profile-v2 article) derives `daily`, `models`,
`arcs`, `insights`, builds cards via `buildInsightCards`, passes them to
`WrappedDeck`. The radar/compare path is identical.

## Error / empty states

- Loading / error / not-found branches preserved; `not-found` →
  `UnclaimedDossier`, restyled.
- `vs` degrade-to-note path preserved.
- Sections that have no data render their existing quiet empty copy
  (`pf-quiet` equivalents), now under `.profile-v2` styling.
- Partial-radar and partial-insight guards preserved.

## Testing

- `apps/site` typecheck (strict-null; needs a prior build for route/content
  codegen - per CLAUDE.md).
- Unit test for `WrappedDeck`: given a card array (incl. a pinned-accent card and
  a viz-less card), it renders one article per card, applies the rotation, and
  honours a pinned accent. Mirrors the existing `dossier-card-art.test.ts` /
  `dashboard-preview.test.ts` pattern.
- Visual check: run the site, load a real `/u/<login>` and a `?vs=` overlay and an
  unclaimed handle; confirm parity with the landing aesthetic. (Staging gotcha
  for live screenshots noted in project memory.)

## Risks / notes

- `pf-*` CSS removal must not regress `leaders.tsx` - audit shared selectors
  first (the base `.profile-page, .leaders-page` rule is shared and stays).
- Hero logo field is decorative; keep `aria-hidden` and ensure the real
  harness list remains available to screen readers (in the vitals or a visually
  hidden list).
- `prefers-reduced-motion` honoured for any ported hero/pulse animation.
- No new global CSS tokens; reuse the shared ramp so light/dark and the `.rdx`
  bridge rules are unaffected.

## Update (during implementation): shared `@ax/recap-deck` package

The reskin surfaced that the wrapped-card CHARTS existed in **three diverging
copies** - studio's canonical `wr-*` registry (`apps/studio/src/instrument/
card-viz.tsx`), the landing's `mc-*` re-port (`dashboard-preview.tsx`), and the
profile's first cut (which cloned the landing copy). The profile therefore drifted
from studio visually. Per user direction ("package the charts both landing &
studio use, share them"), the charts were extracted into a new zero-build
workspace package **`@ax/recap-deck`** (`packages/recap-deck/`):

- `card-viz.tsx` - the canonical `wr-*` chart registry + `CardViz` + `VizKind`/
  `VizSpec`/`VIZ_KINDS` (verbatim from studio).
- `viz.tsx` - nullframe primitives (`Doto`, `Segbar`).
- `deck-card.tsx` - data-agnostic `DeckCard` (the `rdx-card acc-* wr-card` chrome).
- `styles/recap-deck.css` (structural `wr-*`/`rdx-card` rules + Doto `@font-face`)
  and `styles/recap-deck-theme.css` (the `.rdx` dark/light token scope), shipped
  with `doto.woff2`.

All three surfaces now consume the package:

- **studio** imports the chart TS from the package (its `instrument.css` keeps
  the identical structural rules, untouched - zero visual change by construction).
- **profile** renders the deck via `DeckCard`/`CardViz` inside a
  `.rdx[data-theme="dark"]` band; cards are fed grounded `VizSpec`s built from
  `ProfileInsights` + `activity.daily` (real daily series where present, scalar
  gauges normalised against soft ceilings otherwise - never a fabricated series).
- **landing** popups render the package `CardViz`; the local `mc-*` copy and its
  `.mc-*` chart CSS were deleted (−648 lines).

Net: one source of truth for the recap deck; the profile is identical to the
studio recap by construction. The `WrappedDeck` component (Task 1) now wraps the
package `DeckCard` rather than owning card chrome.

## Queued follow-ups (separate PRs, after this lands)

1. AI-driven `ax profile interview` - an agent-conducted interview at publish
   time that captures user-authored highlights (setup wins, per-skill "learn
   more" summaries, taste/philosophy, shipped wins) into a new `highlights`
   block rendered as an "In their words" section. Own spec.

2. Bespoke head-to-head duel page + OG share card (`/u/$a/vs/$b`). The current
   comparison is only the `?vs=` overlay on `/u/$login` (now with hero + ring
   avatars). This adds a purpose-built duel: both avatars side-by-side hero,
   centered overlaid radar, archetype-vs-archetype, win/loss per metric, both
   recap decks, and an `og:image` duel share-card. Revive the prior art from
   PR #494 (`329daf33`, removed in the profile rework) adapted to the reskinned
   profile: the `u.$login_.vs.$other.tsx` route (trailing-underscore escapes the
   parent Outlet, same trick as `blog_.$slug`), `lib/challenge.ts`
   (`compareDecision` redirect + `buildDuelOgImageUrl`), and the
   `functions/og-duel/[a]/[b].ts` Pages Function. Likely wants the inline
   `ProfileDossier` extracted into a shared component first. Own spec.
