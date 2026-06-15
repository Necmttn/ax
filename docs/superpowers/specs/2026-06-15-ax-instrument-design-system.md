# ax "Instrument" design system - LOCKED 2026-06-15

The new ax visual identity, validated in the `/prototype` throwaway route
(branch `feat/redesign-prototype`) and locked for fold-in into the real product.

Source grammar: [nullframe](https://github.com/m1ckc3s/nullframe) (MIT, © 2026
Mick Cesanek) - dot-matrix telemetry HUD. ax adapts it; it is not a clone.

## Thesis - "editorial instrument"

Differentiate from the generic dark-HUD look (Linear / Vercel / nullframe) by
fusing an **instrument panel** with ax's **editorial/receipts** identity:

1. **Green is the primary accent** (not nullframe orange). Orange is demoted to
   `--alert` (rec / live-energy / warnings).
2. **Georgia serif headlines** paired with **Doto** dot-matrix telemetry - an
   editorial voice inside the HUD. Nobody pairs serif with an instrument panel.
3. **Receipt / ledger motif** - dashed tear-lines, provenance stamps
   ("compiled from local transcripts"), install-as-receipt.
4. The **glyph reel / dot-matrix logo screen** is ax's animated sigil.
5. **Multi-harness** is the moat - surface "5 harnesses" everywhere (logo field,
   the cycling dot-matrix logo screen).

## Surfaces

- **LOCKED - Mission Control** (the app / studio shell): icon rail + dense
  telemetry bento + live clock hero.
- **LOCKED - Teams ("ring")**: org-scale instrument board + member roster.
- **Parked - Landing**: wants more takes later. Keep the copy-setup-prompt pill
  (verbatim `AGENT_PROMPT`), the animated harness-logo field, and the dot-matrix
  logo screen; revisit the rest.

## Foundations

### Tokens (scoped, dark + light via `data-theme`)
Dark: `--bg #0b0d0b · --surface #111311 · --surface2 #181b18 · --border #1f241f
· --border-hi #31382f · --dim #5f685e · --sec #939b8f · --pri #e6e9e2 ·
--display #fff · --accent/green #56b06a · --alert #f26522 · --red #d7493b ·
--blue #5b8fd6 · --gold #d6a14a · --violet #9a86f0`. Cell ramp `--c0..c4`,
`--dot #1b211a`, glyph `--glyph-dim #232823 / --glyph-lit #eafff0`.
Light: cream paper - `--bg #f1efe6 · --surface #fbfaf4 · --pri #272a24 ·
--accent/green #2f9e44 · --alert #c85a1b`, etc. (see `redesign.css`).

### Fonts
`--doto "Doto"` (self-hosted woff2, ~8KB) · `--serif Georgia` · `--mono
ui-monospace` · `--sans system`.

## Type rules

- **Serif (Georgia)** - headlines, hero names, section titles, the clock's day.
- **Doto (dot-matrix)** - DISPLAY only. **Exactly ONE hero readout per view**
  (Mission Control: streak; Teams: sessions; clock hero: the time). Overuse
  reads ugly - everything else is mono.
- **Mono (tabular-nums)** - all dense / tabular / inline numbers, labels,
  stamps, the model split, roster rows.

## Colour rules

- **Green-primary.** Green carries brand + "live".
- **Colour lives in the DATA, never as card chrome.** No coloured card borders /
  eyebrow tints (tried, rejected). Colour appears in:
  - **model channels** - each model its own colour (green/blue/gold/violet/rose)
    on its bar + a legend swatch (`modelColor()` helper).
  - **intensity** - the activity heatmap green ramp; the heat-gradient segbar
    (lit segments ramp dark → full accent).
  - **status** - green LED = live, orange LED/`.sq` = rec/alert, red = error.

## Component inventory (prototype → port targets)

`apps/site/app/components/prototype/`:
- `viz.tsx` - **Segbar** (tones + `color` + `gradient` heat ramp), **CellGrid**
  (slam + glim heatmap), **GlyphReel** (procedural dot canvas), **Led**,
  **Doto**, **modelColor()**.
- `logo-matrix.tsx` - **LogoMatrix**: rasterises harness SVGs → 26×26 dot grid,
  cycles them with a green 3-stop ramp + sweep. The "pixel screen".
- `redesign.css` - tokens, primitives, **receipt motif** (`.rdx-tear`,
  `.rdx-stamp`), **`.nf-list`** (scroll region + bottom-fade for overflowing
  fixed-tile lists), **`.nf-swatch`**, the **ClockHero** (`.v-mc-clock`), the
  bento (`.v-mc-*`), Teams (`.v-team-*`).
- `variant-mission-control.tsx`, `variant-teams.tsx` - the two locked surfaces.
- `ClockHero` (in mission-control) - live Doto time + seconds + pulsing dot on a
  dot-grid, serif day / mono date, last-push footer with orange square.

## Motion

`slam` / `seg-in` / `cell-slam` / `glim` / `shine` / `drift` (logo field) /
heat-gradient / clock tick. **All guarded by `prefers-reduced-motion`.**

**Canvas rule (load-bearing):** any canvas (GlyphReel, LogoMatrix) must be
`position:absolute; inset:0` inside a sized parent - a canvas in normal flow
with `height:100%` feeds its bitmap height back into the parent and grows
forever. Always-resize the bitmap to the live box. Pause the rAF loop on
`document.hidden`.

## Patterns

- **Bento grid** of `.rdx-card` tiles; `.span2` / `.row2` spans.
- **Overflowing lists** → wrap in `.nf-list` (scroll + bottom-fade + thin
  scrollbar + padding). Never hard-clip.
- **Dot-matrix logo screen** - a centred square (`aspect-ratio: 1`), cycles the
  5 harness logos.
- **Copy-setup-prompt pill** - the verbatim landing `AGENT_PROMPT`; harness
  icons drift, wiggle faster on hover.
- **Heat-gradient segbar** for streak-style intensity.

## Fold-in plan (into `apps/studio`)

1. **Primitives + tokens** → shared module in studio (port `viz.tsx`,
   `logo-matrix.tsx`, the `.rdx-*` token/primitive CSS, the Doto font). Verify by
   typecheck + build. No visual risk.
2. **Studio shell → Mission Control** - rebuild the masthead/nav as the icon rail
   + clock hero; map the home route to the telemetry bento wired to real
   `WrappedProfile` / cost / dispatch data (not mock).
3. **Teams ("ring") route** - new studio route; needs a team data source (out of
   scope for v1 - start with the personal Mission Control, stub Teams).
4. **Profile (`/u`) + Wrapped** - rework the two open PRs (#400, #397) to this
   system (Doto-restraint, colour-in-data, receipt figures).
5. **Retire** the `/prototype` route + components once folded.

## Open items

- Landing needs more takes (parked).
- Teams needs a real org/ring data model before it's more than a mock.
- Decide the shared home for primitives (studio-local vs a `packages/ax-ui`).
