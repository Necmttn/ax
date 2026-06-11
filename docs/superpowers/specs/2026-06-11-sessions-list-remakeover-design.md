# Sessions List Remakeover - Design

Date: 2026-06-11
Status: approved (brainstorm v5 mockup locked)
Mockup lineage: `.superpowers/brainstorm/81395-1781156096/content/panel-v2..v5.html` (v5 is canonical)

## Goal

Enrich the dashboard `/sessions` list so it serves three purposes without opening a
session: **triage/scanning** (which sessions had friction), **outcome ledger** (what
each session produced), **live monitoring** (what is running / burning now). Recall
(filters/search) stays as-is.

Direction chosen: **lean table + insight expand** ("Direction C") - single-line rows
with a few signal columns, row click expands an inline insight panel ("accordion")
with micro-charts.

## Row design

Column order:

```
[chevron 18px] [status-dot] ID  SRC  PROJECT  DUR  TURNS  BURN  COST  SIGNAL
```

- `DUR`, `TURNS`, `COST` right-aligned (mono font column scanning).
- `chevron` own narrow column; rotates 90° when open; whole row is the click target
  (`cursor:pointer`, `aria-expanded`).
- **status-dot**: green + halo = live (`ended_at` null AND last event < 5 min);
  gray = ended.
- **BURN**: per-turn token sparkline (~20 buckets). Bars default gray
  (`--ink-300`); amber (`--amber-500`) only on buckets exceeding the user's p90
  per-turn burn - outlier rows pop, normal rows stay quiet.
- **SIGNAL**: rightmost triage badge. Tiers: `clean` (green) when corrections +
  tool errors = 0 and data present; `friction N` (red) where
  N = user_corrections + tool_errors; `-` (dim) when no health data.
- Existing features preserved: source filter tabs, text filter, expand-all,
  compare checkboxes, subagent child expansion (`▶ N` prefix), open → link.

## Accordion treatment

Open row + panel form one visual group:

- 3px inset left rail in `--ink-900` on row and panel (NOT blue - blue collides
  with the codex badge).
- Shared `--tint-50` background flowing row → panel.
- Panel bottom border `1px solid var(--line-200)` closes the group.
- Panel left padding aligns the strip's left edge to the ID column text.

## Panel layout - two bands + footer

**Band 1 (hero, full width, fluid up to 760px): Story bar.**
One horizontal bar = the session narrative:

- Phase segments from `phase_span`: plan/exec/review in the slate ramp
  (`--phase-plan/exec/review`), idle gaps in `--phase-idle`.
- Red friction ticks (`--red-700`, 2px) at correction/tool-error timestamps.
- Commit dots: solid green `--green-700`; reverted commits = red `✕` glyph
  (hollow dots unreadable at 7px).
- Subagent lanes: violet (`--violet-500`) bars under the main bar, one per child
  session, positioned by child start/end. Lane rows render only when children
  exist.
- Caption (10px, wraps): `plan 12m · exec 58m · review 18m · idle 16m ·
  ✕3 corrections · ●2 commits ✕1 reverted · ▬ 2 subagents (38% delegated)` -
  colored glyphs in the caption ARE the legend; no legend in the label line.

**Band 2: responsive grid, 4 cells.**
`grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))` - wraps 4 → 2×2 →
1-col; captions wrap (`white-space:normal`, `overflow-wrap:anywhere`); long file
paths ellipsis-truncate.

1. **Outcome** - check-run dot rows (typecheck/test attempts, red→green sequence,
   HTML 10px labels - never SVG text) + durability bar (green/red split) +
   caption `5 commits · 1 reverted · durability 0.8`.
2. **ΔLOC · N files** - green/red add/remove bars + caption
   `+2.1k −940 · top: <file>` (truncated).
3. **Skill arc** - ordered neutral-gray chips joined by `→` (sequence is the
   signal, not hue). Caption may carry a derived label styled as editorial:
   `≈ classic ship arc` (italic, `≈` prefix).
4. **Context** - seesaw line (`--chart-line` stroke): context fill climbs, drops
   at compactions; amber dots (`--amber-500`) at compaction peaks (compaction is
   an event, not a failure - never red); dashed threshold line at 90%.
   Caption: `2 compactions · peaks 92/96% · ends 71%`.

**Footer (right-aligned typographic line, no chart):**
`vs 30d median - cost 2.4×↑ · friction 1.3×↑ · landed 0.7×↓ · cache 71%`
Red deltas = worse than median, green = better. (Replaced bullet-bar chart -
direction semantics flip per metric; typography is unambiguous.)

**Empty states:** cells render only when their data exists; sessions with no
insight data (e.g. 8s codex hook-probes) show a single dim line
`no insight data for this session`. SIGNAL shows `-`.

## Visual system

### Palette (CSS variables; one hue per meaning)

```css
/* neutrals */
--ink-900:#1c2127;  /* primary text, accordion rail, median ticks */
--ink-600:#555c66;  /* secondary text */
--ink-500:#6e7681;  /* labels + captions (4.6:1 on white) */
--ink-300:#b6bcc4;  /* default spark bars, dim, done dots */
--line-200:#e4e7eb; /* borders, dividers, panel bottom */
--line-100:#f0f2f4; /* row dividers, neutral chip bg */
--tint-50:#f7f8fa;  /* open-row + panel bg */

/* red = failure/friction/revert/delete ONLY */
--red-700:#b13434;  --red-300:#e39891;  --red-100:#faeceb;
/* green = pass/landed/durable/add/live ONLY */
--green-700:#1f7a3f; --green-300:#8fc6a0; --green-100:#e8f3ec;
/* amber = elevated-not-failed (hot burn, compactions) ONLY */
--amber-700:#8f6514; --amber-500:#d99a32; --amber-100:#faf1dc;

/* phases - sequential slate ramp (neutral structure, no judgment) */
--phase-plan:#c9d4e0; --phase-exec:#8da2b6; --phase-review:#5e7590; --phase-idle:#ececec;

/* categorical */
--violet-500:#a193cb; --violet-700:#6f5fa3;  /* subagents ONLY */
--chart-line:#9aa7b6;                        /* neutral chart strokes */

/* source identity - badges ONLY, appears nowhere else */
--src-claude-bg:#fdf3d7; --src-claude-fg:#8a6d1a;
--src-codex-bg:#e7eef9;  --src-codex-fg:#2f5fa8;
```

Rules: no stray hues (`#34a853` etc. banned); accordion/selection state is
monochrome ink, never a hue; live dot uses `--green-700`.

### Type scale (two sizes)

| token | px   | use |
|-------|------|-----|
| base  | 11.5 | row cells, panel values, chips |
| small | 10   | th, cell labels (uppercase .06em 600 `--ink-500`), captions, badges, chart labels |

10px floor everywhere. Chart axis/series labels are HTML, never scaled SVG
`<text>`.

### Spacing (4px grid)

- `td { padding:7px 10px }` (~30px rows), `th { padding:6px 10px }`.
- Panel `padding:12px 16px 14px <ID-column-x>px`.
- Cells `padding:0 12-14px`, `1px var(--line-200)` right dividers.
- Fixed bands inside cells: label 14px / chart ≥36px / caption line(s).

## Data & API design

### Constraints (hard-won)

- NO per-row turn-table scans in the list path (`enrichSessions` hang class).
- NO stacked graph derefs in aggregates (`invoked` 87k-edge hang class).
- All list enrichment comes from per-session aggregate tables already written at
  ingest, fetched with `WHERE session IN [page ids]` batch queries.

### `GET /api/sessions` (existing, enriched)

Current 2 queries (session page + spawned counts) grow to **4 batch queries**:

1. session page select (unchanged)
2. spawned child counts (unchanged)
3. `session_health` batch: `turns, tool_errors, user_corrections, interruptions,
   context_pressure, task_label`
4. `session_token_usage` batch: `estimated_cost_usd, estimated_tokens,
   cache_read_tokens, burn_buckets` + `session_metrics` batch:
   `produced_commits, reverted_commits, lines_added, lines_removed,
   durability_ratio, delegation_ratio`
   (3 + 4 may run as separate queries; "4 batch queries" is indicative, not a
   hard cap - the invariant is: all keyed by `session IN [ids]`, no scans.)

List response meta gains `burn_p90: number | null` - the user's 30-day p90
per-turn token burn (same in-process cache as the baseline medians). The SPA
colors sparkline buckets amber only above this threshold.

`SessionListRow` additions (all nullable - enrichment may not exist):

```ts
turn_count: number | null        // session_health.turns (replaces hardcoded 0)
cost_usd: number | null
burn_buckets: number[] | null    // sparkline
friction: number | null          // corrections + tool_errors (server-computed)
signal: "clean" | "friction" | null
produced_commits: number | null
reverted_commits: number | null
lines_added: number | null
lines_removed: number | null
is_live: boolean
```

### `GET /api/sessions/:id/insights` (new, fetched on expand)

One endpoint returns the full panel payload:

```ts
interface SessionInsightsPayload {
  phases: { phase: string; start: string; duration_ms: number }[]
  friction_ticks: { ts: string; kind: string }[]      // reaction_event + tool errors
  commits: { ts: string; sha: string; reverted: boolean }[]
  subagent_spans: { id: string; start: string; end: string | null }[]
  checks: { kind: "typecheck" | "test" | "build"; runs: { ts: string; ok: boolean }[] }[]
  loc: { added: number; removed: number; files: number; top_file: string | null }
  durability: number | null
  skills: { name: string; ts: string }[]               // ordered invoked edges
  context_curve: { t: number; pct: number }[]          // downsampled
  compactions: { ts: string; pct: number }[]
  baseline: {
    cost_ratio: number | null      // this / 30d median
    friction_ratio: number | null
    land_ratio: number | null
    cache_pct: number | null
  }
}
```

- Context curve derived from `turn_token_usage.prompt_tokens` per turn vs model
  context window, downsampled to ≤60 points; compaction events from `compaction`.
- Check runs derived from `diagnostic_event` (kind/status/ts).
- Baseline: 30d per-user medians (cost, friction, time-to-land) computed
  server-side, cached in-process ~5 min.
- Cells with missing source data return `null`/empty arrays; the SPA hides those
  cells.

### Schema change: `burn_buckets`

New field on `session_token_usage`: `burn_buckets` - JSON-encoded `number[]`
(string field per SCHEMAFULL v3 nested-value rule), ~20 buckets, per-turn
estimated tokens downsampled over turn sequence. Written by the token-usage
derive stage at ingest; backfill via normal re-ingest/derive run. Register any
new table in SCHEMA_TABLES - not needed here (field add only), but the schema
test gate applies.

Sessions without `burn_buckets` (pre-backfill) render an empty BURN cell - no
fallback turn-scan.

## Component plan (SPA)

- `SessionsTable` - existing list component: new columns, right-alignment,
  chevron column, signal badge, sparkline (`BurnSpark`, pure SVG/CSS, no chart lib).
- `SessionInsightPanel` - accordion body; fetches `/insights` on first expand,
  caches per session id in memory.
  - `StoryBar` (band 1) - pure-percentage absolute positioning (as mockup).
  - `OutcomeCell`, `LocCell`, `SkillArcCell`, `ContextCell` (band 2).
  - `BaselineFooter`.
- All charts hand-rolled SVG/CSS (no charting dependency) per mockups.
- Palette/type tokens land as CSS variables in the dashboard stylesheet.

## Error handling

- `/insights` failure → panel shows dim `failed to load insights` + retry link;
  row data unaffected.
- Enrichment queries (3/4) failing must not break the base list: wrap in
  Effect catch → rows render with null enrichment (dim `-`).
- Mixed-version data (old ingests missing tables) handled by nullable fields.

## Testing

- `fetchSessionsList` unit tests: enrichment join correctness, null paths,
  query shape (no derefs / no turn scans - assert on SurrealQL strings).
- `/insights` route test: payload assembly from seeded tables; empty-session path.
- Derive-stage test: `burn_buckets` downsampling (n turns → 20 buckets edges).
- Type-level: `SessionListRow`/`SessionInsightsPayload` exported from
  `@ax/lib/shared/dashboard-types` and consumed by SPA without `any`.

## Out of scope

- Recall/filter changes, compare mode changes.
- Sentiment ribbon, tool-mix/treemap/cadence/hook-lane/plan-burndown/sankey
  charts (gallery items cut in shortlisting - candidates for session detail
  view later).
- Codex/Pi/OpenCode cwd-filtered ingest (unrelated).
