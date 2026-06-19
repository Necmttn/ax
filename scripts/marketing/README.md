# ax marketing visual kit

Reusable toolkit for the "devtool benchmark drop" social visuals - dark
wrapped/receipt board, glass tiles, Doto numerals, segmented bars, particle
backdrop - rendered to **seamless-loop mp4/gif** or a crisp **static PNG**.

Built so the marketing assets read as part of the `@ax/recap-deck` studio family
(it shares the Doto font and the dark palette).

```
scripts/marketing/
├── render.ts            # HTML → seamless-loop mp4/gif/png (Playwright + ffmpeg)
├── theme.css            # tokens + primitives: frame, glass .tile, .chip, .seg, .doto, .hook, glows
├── components/
│   ├── particles.js     # deterministic particle data-field backdrop
│   └── segbar.js        # data-attr segmented-bar builder (studio Segbar grammar)
└── templates/
    └── cost-routing.html  # first poster: "paying frontier prices to run grep"
```

## Make a render

```bash
# seamless-loop mp4 (default 6s, 1280×720, 30fps, 2× supersample)
bun run marketing:render scripts/marketing/templates/cost-routing.html

# loop mp4 + gif fallback
bun run marketing:render scripts/marketing/templates/cost-routing.html --gif

# crisp static poster (PNG) at the 3s mark
bun run marketing:render scripts/marketing/templates/cost-routing.html --static --at=3000

# custom out path / timing
bun run marketing:render <tpl.html> --out=/tmp/drop.mp4 --loop=8000 --fps=30
```

Output lands next to the template (or at `--out`). Requires `ffmpeg` on PATH
(plus the repo's `playwright` dep).

## Author a new poster

1. Copy `templates/cost-routing.html` to `templates/<name>.html`.
2. Keep `<link rel="stylesheet" href="../theme.css">` and the two
   `<script src="../components/...">` includes.
3. Edit the markup/data. Put **layout** in the template's own `<style>`; the
   shared primitives (`.tile`, `.chip`, `.seg`, `.doto`, `.hook`, glows) come
   from `theme.css`.
4. Preview live in a browser (`open` the file) - the backdrop animates in
   real time. Then render.

### Segmented bars

```html
<div class="seg" data-total="26" data-on="16" data-color="var(--amber)" data-grad="1"></div>
```
`data-grad="1"` ramps lit cells dark→color (the nullframe heat bar).

### Doto numerals + units

Wrap the number in `.doto`/`.from`/`.to`, and the unit (`% × /mo`) in `.u` so it
renders in clean sans instead of dot-matrix mush:

```html
<span class="doto">60</span><span class="u">%</span>
```

## The render contract (for animated backdrops)

`render.ts` drives motion deterministically so loops are reproducible and wrap
cleanly. Any custom backdrop script must:

- honor **`window.__t`** (milliseconds) as its clock when present; fall back to
  real-time `requestAnimationFrame` when it is `null` (live preview).
- expose **`window.__draw()`** so the harness can redraw one frame after setting
  `window.__t`.
- be **periodic**: pick motion periods that divide `--loop` so frame 0 == the
  frame after the last (seamless). `particles.js` does this via Lissajous paths
  on harmonics of `data-period`.

CSS animations are scrubbed automatically via the Web Animations API - just keep
their durations dividing `--loop` (e.g. 2s pulses in a 6s loop).

## Attribution

These are shareable artifacts: keep the small `ax · …` credit on-image and link
`github.com/Necmttn/ax` in the post copy (per the repo attribution rule).

## Experimental: html-in-canvas

The WICG `drawElement()` proposal can rasterize live DOM into a canvas for
shader warps (ripple/refraction on the numbers). It is flag-gated
(`chrome://flags → Experimental Web Platform features`) and does **not** render
in the headless harness - treat it as a browser-only enhancement, not a
lockable output.
