# Redesign prototype - THROWAWAY

**Question:** Should ax pivot its whole visual identity to the nullframe
instrument-panel look (desktop-app feel, dark + light), instead of the current
editorial design which feels generic/blunt?

**Route:** `/prototype?variant=A|B|C&theme=dark|light` (floating switcher cycles
variants + toggles theme; arrow keys ← → cycle).

Source grammar: github.com/m1ckc3s/nullframe (MIT, © 2026 Mick Cesanek).

## The three takes

- **A - Mission Control** (`variant-mission-control.tsx`): dark-first desktop
  HUD. Icon rail + dense telemetry bento (archetype hero w/ glyph reel, Doto
  numerals, activity heatmap, streak segbar, model split, push feed). The
  "is it a desktop app" answer. Most nullframe.
- **B - Editorial Instrument** (`variant-editorial.tsx`): ax's existing serif/
  receipts identity, evolved - keeps the big `@handle` serif masthead + section
  kickers, but every number is dot-matrix Doto, activity is a cell-grid, model
  split is segmented bars. Least disruptive; light-first.
- **C - Terminal OS** (`variant-terminal-os.tsx`): windowed desktop-OS shell -
  menubar, ⌘K palette, traffic-light windows, `ax profile show` terminal pane,
  side windows (vitals / model-split / skills). Most "developer tool".

All three support dark + light via `data-theme` on the `.rdx` scope (token sets
in `redesign.css`). Shared nullframe primitives in `viz.tsx` (Doto / Segbar /
CellGrid / GlyphReel / Led). Mock data in `mock.ts`.

## DECISION: <pending - user picking direction>

Likely outcome is a blend ("masthead from B, panels from C" etc). Capture the
chosen direction here, then: promote the winning structure into the real
surfaces (studio shell + /u profile + wrapped), port `viz.tsx` + the token sets
into a shared place, and DELETE this `/prototype` route + the components dir.

Do not ship the switcher (gated to non-prod, but the whole route should go).
