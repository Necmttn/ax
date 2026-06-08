# Sessions experience - design review

A holistic, high-end review of the **list → inspector → share** triad in the ax
studio, read as one system. Scope:

- Sessions list - `apps/axctl/src/dashboard/web/src/routes/sessions.tsx`
- Session inspector - `apps/axctl/src/dashboard/web/src/routes/session-inspect.tsx`
- Shared session view - `apps/axctl/src/dashboard/web/src/routes/share-inspect.tsx` + `Shell.tsx`
- Tokens - `apps/axctl/src/dashboard/web/src/styles.css`

This is taste work, not a checklist. It is opinionated and concrete. No source
was edited.

---

## TL;DR

The sessions triad has **excellent data and weak design discipline.** It is the
most information-rich part of the studio and the least visually governed. The
core problem is not "too dense" - density is the brand - it is that **the three
surfaces stopped using ax's own design tokens and drifted into an ad-hoc
slate/Tailwind palette baked inline** (`#0f172a`, `#64748b`, `#e2e8f0`,
`#f8fafc`, `#cbd5e1`). The list looks like a different product than the canvas
and skills screens, which faithfully use `--ink / --muted / --line / --page`.
The inspector multiplies this into ~40 hardcoded hex values across `KIND_STYLE`,
`ALIAS_STYLE`, cost colors, and markers.

Second problem: **the surfaces answer the wrong question.** The list answers
"which rows exist" (id, source, timestamp) when the user wants "what happened,
how big, how much, did it work." The share view answers "here is a transcript"
when a cold stranger needs "here is what this session accomplished, in one
breath" - and the data to say that (`session.summary`, `stats`, `totals`) is
already in the artifact and thrown away on a single meta line.

Fix the token drift, add an **outcome layer** (a per-row signal strip + a share
summary header), and tame the inspector's color budget. Identity stays exactly
where it is: paper-light, Georgia wordmark, mono data.

---

## Quick wins (high impact, low effort)

1. **Kill the inline slate palette.** Replace every `#0f172a → var(--ink)`,
   `#64748b/#475569 → var(--muted)`, `#e2e8f0 → var(--line)`,
   `#f8fafc → var(--page)`, `#cbd5e1 → color-mix(--muted 55%, --page)`,
   `#3b82f6/#2563eb → var(--blue)`. One find-replace pass makes the list match
   the rest of the studio. **(P0, ~1hr, single biggest visual upgrade.)**
2. **Right-align + tabular-nums the numeric columns** (turns, duration) and add
   `font-variant-numeric: tabular-nums` so the spreadsheet reads like a ledger,
   not ragged text. Already a token pattern (`td.num` in styles.css) - reuse it.
3. **Move the filter chips and search into the `panel header`** instead of a
   second inline flex row below it. The skills screen already does this with
   `.toolbar`; sessions reinvented it inline.
4. **Share header: render `session.summary`.** The artifact carries it
   (`ShareArtifact.session.summary`) and it is never shown. Even one line of
   "what this session did" transforms the cold-open. **(P0, the share view's
   single highest-leverage change.)**
5. **Promote the CostRail's session total + cost mix** into the inspector
   header strip (it currently only lives in the sticky rail and `InspectGuide`).
   A reader should see "$1.42 · 47 turns · 12 tools · 2 subagents" before they
   scroll.
6. **Replace the raw `open →` text-link** in the list with a full-row click
   target (the skills table already does this with `tr.skill-row { cursor:
   pointer }`). The whole row should be the affordance; the arrow stays as a
   hint.
7. **Lowercase-mono section labels are inconsistent.** `cost so far`,
   `inspector`, `estimated cost lens` are lowercase mono; the panel `<h2>`s are
   uppercase serif-adjacent. Pick one register for "data labels" (uppercase
   mono, `letter-spacing: 0.06em`, `--muted`) and apply everywhere.

---

## Cross-cutting issues

### 1. Token drift is the root cause of the "two products" feeling

`styles.css` defines a deliberate, calm palette: `--ink #141615` (near-black
green-tinted), `--muted #66706b`, `--page #f3f6f5`, `--line #cfd8d4`, and four
semantic accents (`--green --blue --red --gold`). The canvas, skills, graph, and
recall screens use them and feel like one publication.

The sessions triad does not. It uses a **cooler, bluer slate ramp** copy-pasted
inline:

- list rows: `#64748b`, `#cbd5e1`, `#f8fafc`, `#e2e8f0`, `#0f172a`
- inspector: `#334155`, `#94a3b8`, `#d8dee8`, `#e2e8f0`, plus blue `#2567a8`
  (close to `--blue` but not equal) and cost colors `#f59e0b #10b981 #8b5cf6`
- source badges: a pastel set (`#fef3c7/#92400e` etc.) unrelated to the accents

The result: the list's grays are ~5–8% bluer and lighter than `--muted/--line`,
its black is `#0f172a` (cold navy) vs `--ink #141615` (warm near-black), and its
background washes are `#f8fafc` (blue-white) vs `--page #f3f6f5` (warm
paper-green). Side by side with the canvas screenshot, the sessions list reads
as "a Tailwind admin table dropped into a letterpress magazine." This is the
**number-one thing to fix** and it is almost entirely mechanical.

**Target:** every neutral resolves to an ax token or a `color-mix()` of one.
Keep the *number* of distinct grays low - `--ink`, `--muted`, a single
`--muted-2` (≈`color-mix(--muted 55%, --page)`) for tertiary text like the
"-"/placeholder dashes, `--line`, `--track`, `--page`, `--panel`. That's the
whole neutral ramp. Right now there are roughly eleven.

### 2. The semantic-color budget in the inspector is over-drawn

`KIND_STYLE` (11 entries) + `ALIAS_STYLE` (18 entries) + `blockFamily` fallbacks
+ `atomTone` + marker tones = on a dense turn the screen can show a dozen
simultaneous background/foreground/bar color pairs, each at full pastel
saturation. This is the opposite failure of token drift: not *off-brand*, just
*too loud*. The eye has no rest. ax's restraint elsewhere (one blue accent, one
green) is abandoned here.

**Target:** collapse to a **6-tone semantic scale** anchored on the four ax
accents plus ink/muted:

| role group           | tone        | maps from today's sprawl |
|----------------------|-------------|--------------------------|
| user / objective     | `--gold`    | user_input, objective, todo |
| assistant / output   | `--ink`     | assistant_text, plan |
| tool (call+result)   | `--blue`    | tool_use, tool_result, tool_call/output |
| context / skill / sys| `--muted`   | skill_context, system_context, wrapper, reference, manifests |
| hook / verification  | `--green`   | hook_injection, verification, evidence |
| error / correction   | `--red`     | failures, completion_audit, pasted, mismatch |

Tool-call vs tool-result can differ by **fill vs outline of the same blue**,
not two unrelated purples (`#8b5cf6` vs `#a855f7`). Subagent stays a distinct
warm tone (it is genuinely a different *axis* - a fork, not a content kind) but
should use one consistent rose (`#e11d48`) instead of the current
ffe4e6/fecdd3/fff1f2/9f1239 four-shade pile.

This drops the on-screen color count from ~12 to ~6 and makes the rare colors
(red = something broke, rose = a child was spawned) actually *mean* something.

### 3. The surfaces describe structure, not outcome

Across all three: characters, char-share %, span counts, token mix, block
offsets, blockset hashes, parser versions. This is superb forensic instrumentation
- and it is *all* the user gets. Nowhere does any surface say, in plain
language, **what the session was trying to do and whether it worked.**

- List: id / source / project / started / duration / turns. No cost, no
  files-touched, no pass/fail, no size-at-a-glance.
- Inspector: leads with a cost-mix bar and an 11-chip char-share legend before
  a single word of the conversation. The forensic layer is the *headline*; the
  human layer is buried.
- Share: a stranger gets `42 turns · 191,203 chars · source: gist:…` and then
  raw transcript.

`stats { turns, tool_calls, files_changed, skills_used, failures }` and
`totals { cost_usd, duration_ms, subagents }` and `session.summary` **already
exist** in the share artifact. The DB has them for the live views. The design
just doesn't spend them. That is the central opportunity.

### 4. Hierarchy is flat where it should be layered

Every surface is one type size (≈11–13px mono) on one background. There is no
"this is the headline, this is the body, this is the metadata" gradient. The
inspector's per-turn header line packs seq + role badge + spawn badge + jsonl
badge + timestamp + size + token line + inspecting badge + alias chips into a
single 11px wrapping flex row - eight semantic groups at identical weight. The
eye can't triage.

---

## Per-surface critique

### A. Sessions list (`sessions.tsx`)

**What works**

- Intent-based prefetch on row hover (`onIntent` → `prefetchQuery`) and
  `preload="intent"` on the open link - genuinely premium interaction; the
  inspector is warm before you click. Keep and celebrate this.
- The subagent expand-arrow (`▶ 3` → indented `↳` children) is a clean
  disclosure pattern and the right mental model (sessions are trees).
- IntersectionObserver infinite scroll with a manual "load 200 more" fallback is
  solid and matches recall.tsx. The re-entrancy `loadingRef` guard is careful.
- The "200 of 1,744 roots · 65 with subagents" meta line is a good *instinct* -
  it just lives in tiny muted text and stops short of being a real summary.

**What's weak**

- **Pure token drift** (see cross-cutting #1). Header row `#f8fafc` bg + `#475569`
  text; rows use `#64748b`, `#cbd5e1`; filter buttons `#0f172a`/`#e2e8f0`;
  `open →` is `var(--blue, #3b82f6)` - note the *fallback* is wrong (`#3b82f6`
  is not `--blue #2567a8`). Almost nothing here uses the real tokens.
- **The table is a manifest, not a dashboard.** It tells you a row exists. It
  does not tell you the row is *big* (191k chars), *expensive* ($1.40), *failed*
  (3 tool errors), or *productive* (12 files touched). Every one of those is a
  derivable signal and none is shown. A user scanning 200 rows has no way to
  find "the session that cost the most" or "the one that touched auth.ts."
- **`turns` column uses `#cbd5e1`** (near-invisible light gray) for the count
  and a literal `"-"` for zero - the single most useful at-a-glance number
  (how long was this) is the *faintest* thing in the row.
- **Source badges are a fifth palette.** Five custom pastel pairs that match
  neither the accents nor `KIND_STYLE`. They're fine in isolation but they're a
  third color system the user must learn.
- **Filter chips are visually identical to the compare/expand buttons** (same
  size, border, radius) so the toolbar reads as one undifferentiated button
  soup. Filters (state) and actions (verbs) should look different.
- Header `<h2>Sessions</h2>` is the panel default (uppercase) but the meta line,
  toolbar, and table headers each invent their own type treatment.

**Sketch - outcome-bearing row**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Sessions                          1,744 roots · 65 spawned subagents · ⌕   │  ← panel header owns search
│ [all] claude codex pi opencode cursor          ·   sort: recent ▾  cost ▾  │  ← filters distinct from sort
├──────────────────────────────────────────────────────────────────────────┤
│ ▶3  a1b2c3   ◷ refactor ingest pipeline to Effect layers          claude   │  ← title = summary, not id
│      ax · 2h 14m · 47 turns · $1.42 · 12 files · ✓                 2d ago   │  ← signal strip, tabular
│      ▓▓▓▓▓▓▓▓░░  cost   ▓▓▓░░░░░░░ tools  ●● subagents                      │  ← tiny inline sparkbars (optional)
├──────────────────────────────────────────────────────────────────────────┤
│      ↳ "audit the schema migration"        codex · 8m · 6 turns · $0.11    │  ← child inherits the strip
└──────────────────────────────────────────────────────────────────────────┘
```

The id moves to a hover/secondary position; the **first line becomes the
session's one-line summary** (same source as the share `session.summary`, or a
derived "first user message" fallback). The second line is the signal strip:
duration · turns · cost · files · outcome glyph, all tabular-aligned. A `✓`/`✗`
outcome glyph (derived from `failures > 0`) gives instant pass/fail scanning.
This is a *list of outcomes*, not a list of rows.

If a full redesign is too much for v0.1, the **minimum** is: add cost + a
files-touched/failures pair to the existing table as two right-aligned tabular
columns, and color the turn count `--ink` not `#cbd5e1`.

### B. Session inspector (`session-inspect.tsx`)

**What works**

- The **docked rail** (CostRail + TurnContentInspector) is a genuinely strong
  idea: one persistent inspector that follows the last-hovered block instead of
  per-turn toggles. `useInspectSelection` seeding it to the first parsed turn is
  thoughtful. This is the best-designed component in the triad.
- `useVisibleTurnSeq` driving "cost so far through #N · X% of session" as you
  scroll is a lovely, almost cinematic touch - cost accrues live as you read.
  Nobody else does this.
- `AnnotatedRawText` painting semantic blocks *in place* on the raw transcript
  (with symbol bolding via `renderSliceWithSymbols`) is the right call: annotate
  the truth, don't replace it.
- The jump bar (next correction / spawn / tool_use / hook fire), `#turn-N`
  deep-linking, and the spawn/hook inline markers are real power-user navigation.
- `content-visibility: auto` virtualization (in the share body) keeping every
  turn in the DOM for jumps/find is the correct, sophisticated tradeoff.

**What's weak**

- **The header is forensic-first.** On load the user sees: a project/turns/chars
  line, possibly a rose subagent bar, the FilterBar, then `InspectGuide` (a
  cost-mix gradient bar + four cost-component chips), then an **11-chip
  char-share legend** (`user input 4.2% · assistant text 38% · tool use 12% …`),
  *then* the conversation. Five rows of instrumentation before content. A
  newcomer bounces. The cost mix and char-share are *analysis*, not
  *orientation* - they belong in a collapsible "session anatomy" disclosure or
  the rail, not above the fold.
- **Per-turn header overload** (see cross-cutting #4): seq · role badge · spawn
  badge · jsonl badge · ts · `12.4k c · 7span` · `$0.03 · 4.2k tok · 1.1k fresh
  · 3k cached · 200 out` · inspecting badge · up to 8 alias chips - one wrapping
  11px line. Realistically this wraps to 2–3 lines per turn and the *content*
  (the actual message) starts below a thicket of metadata. The token line alone
  is five `·`-joined values.
  **Target:** turn header = `#seq  ROLE  ·  12.4k  ·  $0.03  ·  09:14:22` and a
  single right-aligned "kind" pill (the dominant kind), with the full
  token/alias breakdown moving to the docked inspector when that turn is
  selected (it's already the inspector's job).
- **Color over-draw** (cross-cutting #2): a single tool-heavy turn shows purple
  tool_use, purple-2 tool_result, blue skill, gray system, the alias chips in
  green/orange/teal/cyan, plus the left role bar. It's a stained-glass window.
- **The cost vocabulary is inconsistent across three places.** `InspectGuide`
  (top), the per-turn token line, and `CostRail` (right) each render cost
  differently with different colors (`#2567a8` fresh in guide/rail but the
  per-turn line uses plain `--muted`). One cost visual language, defined once.
- Hardcoded `top: 48` sticky offsets in CostRail/DockedRail assume a fixed
  masthead height; fragile if the masthead reflows (it does, on mobile, per the
  `@media` rules).

**Sketch - calmer above-the-fold**

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Session inspect    refactor ingest pipeline to Effect layers               │  ← summary as the H2 subject
│ claude · ax · 2h14m · 47 turns · $1.42 · 12 tools · 2 subagents · ✓        │  ← ONE outcome strip (replaces 3 rows)
│ ▸ session anatomy (cost mix · char-share legend)                           │  ← the forensic rows, collapsed
├───────────────────────────────────────────────────────┬────────────────── │
│ [next correction] [next spawn] [next tool] [next hook] │  COST SO FAR      │
│                                                         │  $0.84            │
│ #12  USER   · 1.2k · 09:14:22                  [tool]   │  through #12 ·59% │
│   refactor the ingest pipeline so each stage…           │  ▓▓▓▓▓░░░         │
│                                                         │  fresh   $0.31    │
│ #13  ASSISTANT · 8.4k · $0.04 · 09:14:30      [tool]    │  cache   $0.40    │
│   I'll restructure StageRegistry into Effect layers…    │  output  $0.13    │
│   ↳ spawned "audit schema migration"  codex · $0.11     │  ── inspector ──  │
│                                                         │  [hovered block]  │
└───────────────────────────────────────────────────────┴────────────────── │
```

### C. Shared session view (`share-inspect.tsx` + `ShareChrome`)

This is the surface with the **biggest gap between current and potential**,
because it's the one a stranger judges cold and the one that drives the viral
loop ("Map your own agent sessions → Get ax").

**What works**

- `ShareChrome` is a clean, honest slim header: serif `ax` wordmark + mono
  `agent experience` tag + a single CTA. Restraint is right; a share page should
  not have the full nav.
- The v3 multi-file bundle (manifest → lazy subagent files, prefetch on hover,
  `↑ back to parent` breadcrumb) is sophisticated and the right architecture for
  sharing agent *trees*.
- `ShareSpawnMarker` already shows cost · duration · turns per child - proof the
  outcome data exists and renders nicely *inline*; it just isn't summarized *up
  top*.

**What's weak - the cold-open problem**

A stranger lands on:
```
Shared session inspect   a1b2c3… · gist share · 2 subagents · $1.42 · 2h14m
↓ spawned 2 subagents  "audit…" ($0.11) · "fix…" ($0.30)
42 turns · 191,203 chars · source: gist:owner/abc123
[cost-mix bar] [11 char-share chips]
#0 USER  …raw transcript…
```
There is **no framing**. No title. No "here's what happened." The most
human-legible field in the whole artifact - `session.summary` - is fetched,
typed, and **never rendered.** The `stats` object (`tool_calls`,
`files_changed`, `skills_used`, `failures`) is collapsed into a tiny gray meta
line in the `panel header`. The first real content a stranger reads is a
char-share legend. This is the equivalent of sharing a YouTube link that opens
on a frame-by-frame byte inspector instead of a title + thumbnail.

**Target - a real "outcome header"** (the centerpiece proposal)

Borrow the *shape* of the existing `.wrapped-hero` (already in styles.css:
left-bordered accent block, big number on the right) - ax already has the visual
vocabulary, it's just not used on share. Render it above the transcript:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ax · shared agent session                                  [Get ax →]     │  ← chrome
├──────────────────────────────────────────────────────────────────────────┤
│  Refactored the ingest pipeline into Effect layers          ┌───────────┐  │
│  and audited the schema migration                           │   $1.42   │  │  ← session.summary as a headline (serif, ~22px)
│                                                              │  2h 14m   │  │
│  claude · ax repo · Jun 8                                    └───────────┘  │
│                                                                            │
│  47 turns   ·   12 tool calls   ·   12 files   ·   2 subagents   ·   ✓ 0 fail │  ← stats as a stat row, not a meta line
├──────────────────────────────────────────────────────────────────────────┤
│  ▸ full transcript (47 turns)                                              │  ← transcript COLLAPSED by default on share
└──────────────────────────────────────────────────────────────────────────┘
```

Key moves:

1. **`session.summary` becomes the headline** in Georgia serif (~22px,
   matching `.wrapped-hero h3`). This is the single highest-leverage change in
   the whole review. If `summary` is absent, fall back to the first user turn's
   first sentence - never lead with an id.
2. **`stats` becomes a horizontal stat row** with the outcome glyph
   (`✓ 0 fail` / `✗ 3 fail`), not a `panel header` meta crumb.
3. **The transcript collapses by default on share.** A stranger wants the story
   first; the forensic transcript is opt-in (`▸ full transcript`). The
   `InspectGuide` char-share legend should *never* be the share view's
   above-the-fold - it's analyst tooling. (Keep it expanded in the *local*
   inspector where the user is an analyst.)
4. **The CTA gets a reason.** "Map your own agent sessions → Get ax" is generic.
   Tie it to what they just saw: *"This session cost $1.42 and ran 2h14m across
   2 subagents. See your own → Get ax."* The outcome header makes the CTA
   self-justifying.
5. **Add OG/meta tags** from the manifest (`og:title = session.summary`,
   `og:description = stats line`) so the *unfurl in Slack/Twitter* shows the
   outcome, not a blank ax page. The shareability story is half-won at the unfurl,
   before anyone clicks.

---

## Target visual direction (evolve, don't replace)

Keep: paper-light `--page` grid, Georgia `ax` wordmark, mono for all data, the
2px ink masthead rule, panel-on-paper cards, the calm four-accent palette. The
identity is good and recognizable in the screenshots - the canvas and skills
screens are genuinely handsome.

Evolve toward three principles:

1. **One neutral ramp, one accent set, six semantic tones.** Everything in the
   triad resolves to `--ink / --muted / --muted-2 / --line / --track / --page /
   --panel` + `--green --blue --red --gold` + the single rose for "fork." Delete
   the slate ramp and the alias-color sprawl. This alone unifies the three
   surfaces and the rest of the studio.
2. **Three-level type hierarchy, applied everywhere.**
   - *Subject* - Georgia serif, the session summary/headline (share hero, inspector
     H2 subject). This is the one place serif leaves the wordmark, deliberately,
     to mark "human meaning."
   - *Body* - the transcript / content, mono 12–13px, line-height 1.5.
   - *Data label* - uppercase mono 10–11px, `letter-spacing: 0.06em`, `--muted`.
     Used for every metric label, badge, column header. One register, no more
     lowercase-vs-uppercase coin-flips.
3. **Outcome before structure.** Every surface leads with what happened
   (summary, cost, turns, pass/fail) and tucks the forensic layer (char-share,
   cost-mix, blockset hashes, parser versions) into disclosures or the rail. The
   instrumentation is a crown jewel - it should feel *earned by scrolling*, not
   thrown at you in row one.

---

## Prioritized proposals

### P0 - unification + outcome (do these first)

- **P0.1 Token sweep.** Replace all inline slate/Tailwind hex in the three route
  files with ax tokens (mapping in cross-cutting #1). Add `--muted-2:
  color-mix(in srgb, var(--muted) 55%, var(--page))` to `:root` for tertiary
  text. Fix the `var(--blue, #3b82f6)` fallback to `var(--blue)`. Mechanical,
  ~1–2hr, transforms cohesion.
- **P0.2 Share outcome header.** Render `session.summary` as a serif headline +
  `stats`/`totals` stat row + cost/duration block, reusing `.wrapped-hero`
  shape. Collapse the transcript behind `▸ full transcript`. Add a summary
  fallback (first user turn). (cross-cutting #3, surface C.)
- **P0.3 Inspector outcome strip.** Collapse the three pre-transcript rows
  (project line + InspectGuide + char-share legend) into one outcome strip
  (`claude · ax · 2h14m · 47 turns · $1.42 · 12 tools · 2 subagents · ✓`) plus a
  `▸ session anatomy` disclosure holding the cost-mix bar and char-share legend.
- **P0.4 List signal columns.** Add right-aligned tabular `cost` and a
  `files/fail` pair to the list; color `turns` with `--ink` not `#cbd5e1`. Even
  without the full row redesign this answers "what happened / how big / how much."

### P1 - hierarchy + legibility

- **P1.1 Semantic 6-tone collapse.** Re-map `KIND_STYLE` + `ALIAS_STYLE` onto
  the six-tone scale (table in cross-cutting #2). Tool call vs result = fill vs
  outline of `--blue`. One consistent rose for subagent. Cuts on-screen color
  count ~50%.
- **P1.2 Turn header diet.** Reduce the per-turn header to
  `#seq ROLE · size · $cost · ts` + one dominant-kind pill; move the full token
  breakdown + alias chips into the docked inspector for the selected turn.
- **P1.3 List row redesign.** The two-line outcome row (summary + signal strip),
  full-row click target via a `.session-row` class mirroring `.skill-row`.
- **P1.4 Unify cost visual language.** One `<CostMix>` primitive used by
  InspectGuide, CostRail, and per-turn, with one color mapping
  (fresh=`--blue`, cache=`--gold`, output `--green` or a defined fourth).

### P2 - delight + shareability

- **P2.1 Share OG/meta tags** from the manifest (`og:title`, `og:description`,
  optionally a generated OG image with the stat row) so links unfurl as outcomes.
- **P2.2 Self-justifying CTA** that interpolates the session's own cost/turns.
- **P2.3 List sort by outcome** (cost ▾, turns ▾, recent ▾, failures ▾) so the
  ledger is queryable - "show me my most expensive sessions" / "sessions that
  failed."
- **P2.4 Inline sparkbars** in list rows (cost magnitude, tool intensity) - the
  `.timeline-track`/`.timeline-bar` and `.jaccard-bar` primitives already exist
  in styles.css and can be reused, keeping it on-brand.
- **P2.5 Robust sticky offsets** - replace `top: 48` magic numbers with a CSS
  var (`--masthead-h`) set on the shell so the rail survives masthead reflow.

---

## Design references - what to borrow, specifically

- **Linear** - *typographic restraint and one-direction scanning.* Linear's lists
  are dense but legible because they use a single tight type scale (≈14px base,
  ~1.125 ratio) and never put more than one emphasis per row. Borrow: the
  three-level hierarchy and the discipline of "one bold thing per line." Don't
  borrow its dark chrome - ax is paper-light on purpose.
- **Sentry / Datadog trace view** - *outcome-first headers + progressive
  disclosure.* A Sentry trace opens with a summary (duration, span count,
  error count, status) and the waterfall is *below* it; spans expand on demand
  (`+` to drill in) rather than dumping every span. Borrow: the share/inspector
  outcome header, and "transcript collapsed, expand to drill" - directly
  applicable to the cold-open problem and the subagent tree.
- **Val Town** - *shareable-by-default dev artifacts with a human frame.* Every
  shared val leads with a title + author + what-it-does, then the code. Borrow:
  the share view's "title before bytes" principle and the self-justifying-share
  loop.
- **Vercel deployment summary** - *the stat strip.* Vercel's deploy page leads
  with status + duration + a tidy horizontal stat row (commit, branch, build
  time) in tabular mono before logs. Borrow: the exact pattern for the list
  signal strip and the share/inspector stat row - calm, tabular, scannable.
- **tldraw / Excalidraw** - *the canvas already nails this in ax;* the lesson for
  the *list and share* is that ax's own canvas screen is more visually confident
  than its sessions list. Borrow from your own canvas: the comfort with
  whitespace and the single-accent restraint, and bring it back into the table.

Sources:
- [Sentry - Trace View](https://docs.sentry.io/concepts/key-terms/tracing/trace-view/)
- [Datadog - Trace View](https://docs.datadoghq.com/tracing/trace_explorer/trace_view/)
- [Linear design system (Refero)](https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1)
- [Linear design - LogRocket](https://blog.logrocket.com/ux-design/linear-design/)
- [Design Systems - Typography guides](https://www.designsystems.com/typography-guides/)
- [Typography in Design Systems - EightShapes](https://medium.com/eightshapes-llc/typography-in-design-systems-6ed771432f1e)
