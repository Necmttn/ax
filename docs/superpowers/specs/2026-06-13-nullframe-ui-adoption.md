# Nullframe UI adoption - wrapped, landing, profile

Source: https://github.com/m1ckc3s/nullframe (MIT, © 2026 Mick Cesanek).
Nothing-design-language telemetry dashboard: React 19 + Motion + hand-written CSS, ~600 LOC total.

## What's worth stealing (element inventory)

| Element | Where in nullframe | Mechanism |
|---|---|---|
| **Dot-matrix numerals** | `.clock`, `.doto-val` (`styles.css:71-96`) | [Doto](https://fonts.google.com/specimen/Doto) Google Font (OFL), `font-variant-numeric: tabular-nums` |
| **Segbar** | `Segbar.tsx` + `styles.css:98-107` | flex row of `<i>`, staggered `seg-in` (scale .3→1, back-ease, 45ms/seg). White/green/orange variants |
| **Cell-slam contribution grid** | `ContributionsCard.tsx` + `styles.css:112-124` | CSS grid of `<i>`, `cell-slam` keyframe (scale 0→1.35→1), diagonal stagger `(week+day)*18ms`, ResizeObserver fits weeks to width |
| **Glim pulse** | `ContributionsCard.tsx:27-41` | random lit cell flashes white 420ms every 650ms - makes static data feel alive |
| **Glyph reel** | `GlyphCard.tsx` | canvas 11×7 dot grid morphing through 9 procedural patterns (disc/ring/brackets/pause/wave/dither), slam-in per pattern switch |
| **Shine sweep** | `Card.tsx` + `styles.css:30-37` | skewed white gradient sweeps across card on hover or global "sync" event (staggered `index*70ms`) |
| **Card entrance** | `Card.tsx:39-41` | Motion spring `{stiffness:380, damping:26}`, y:22 scale:.93→1, `index*0.07s` stagger |
| **LED pulse** | `.led` (`styles.css:60-63`) | 10px dot, opacity 1→.18 pulse 2.4s |
| **Dot-grid panel bg** | `.hero` (`styles.css:65-69`) | `radial-gradient(circle,#1d1d1d 1.1px,transparent 1.1px)` 16px tile |
| **Ring progress** | `.ring-*` (`styles.css:81-89`) | SVG stroke-dashoffset, value centered |
| **Streak wave** | `.streakbar` (`styles.css:136-142`) | segbar + infinite `brightness(.5→1.25)` wave |
| **LIVE/SIM honesty tags** | `Card.tsx` `.tag` | corner mono label, visible on hover (or `always`) - never lie about data source |
| **Feed rows** | `ActivityCard` `.feed-*` | mono activity log, dim right-aligned timestamps |
| **Seismograph** | `SeismoCard.tsx` | canvas line of live input rate w/ REC dot |

Engineering pattern worth copying too: **one rAF loop** drives all canvases, publishes snapshot to React at 2 Hz via `useSyncExternalStore`; DPR capped at 2; offscreen canvases skip work; everything pauses on hidden tab; `prefers-reduced-motion` kills all of it.

## Tension with ax identity

ax site/studio = light paper editorial ("receipts"): cream `--page`, Georgia serif, green ink. Nullframe = black industrial instrument panel. Don't wholesale re-theme. Adopt the **motion grammar** (slam-and-settle, stagger, glim) and **dot-matrix structure** (Doto numerals, segmented bars, cell grids) into existing tokens. Slam beats fade - current ax viz mostly static.

## Per-surface mapping

### Wrapped (`apps/studio/src/routes/wrapped.tsx`, `wrapped-cards.tsx`, `styles.css:1944,2474-2546`)
Best fit - special-occasion surface, can go furthest. Option: full dark "instrument panel" mode just for wrapped.
- `.wrapped-metrics` numbers → Doto numerals w/ tabular-nums
- Active-days metric → cell-slam contribution grid + glim pulses (real data, not the strip fake)
- Streak → streakbar w/ brightness wave
- Card deck entrance → Motion spring stagger (replace static render)
- Archetype badge card → glyph-reel canvas as the "art" (procedural patterns seeded by archetype)
- Token scale viz → segbar

### Profile (`apps/site/app/routes/u.$login.tsx`, `globals.css` `.pf-*` ~9549+)
- `.pf-vital-num` → Doto numerals (paper-light fg, same font works on cream)
- `.pf-chart` day bars → cell-slam stagger on mount + glim on lit cells
- Live-fetched gist data → corner `LIVE` tag (honesty label fits ax receipts ethos perfectly)
- `.pf-card-art` → optional glyph-reel canvas variant

### Landing (`apps/site/app/routes/index.tsx`, `.fig-heatmap` `globals.css:1468-1667`)
- `.fig-heatmap` tiles → cell-slam entrance + glim pulse on lit tiles
- Stat counters in `DashboardPreview` → Doto numerals
- Hero panel → subtle dot-grid background (light variant: `#e6e4dc` dots on cream)
- "live" indicators → LED pulse dot
- Card hover → shine sweep (light variant: dark gradient at low opacity)

## Suggested build order

1. **Shared primitives** (site + studio each, no shared pkg yet): Doto font load, `seg-in`/`cell-slam`/`glim` keyframes, `Segbar` + `CellGrid` components, reduced-motion guards.
2. **Wrapped remake pass** - biggest payoff, lowest identity risk.
3. **Profile vitals + chart** - Doto + slam.
4. **Landing heatmap + hero** - most identity-sensitive, do last.

## Caveats

- Doto adds a font download (~15-40KB per weight subset) - subset to digits+punct for numerals-only use.
- Site profile/leaders client-fetch raw gists - keep components dependency-light (no Motion on site; CSS keyframes cover slam/glim/seg-in fine; Motion only needed for spring entrance, which CSS can approximate).
- Studio is plain CSS, site is Tailwind v4 + custom CSS - keyframes land in each app's stylesheet; tokens stay per-app (no shared token file exists today).
- MIT attribution: keep the credit line in this doc; code we write is adaptation, not wholesale copy of their CSS (though MIT permits it).
