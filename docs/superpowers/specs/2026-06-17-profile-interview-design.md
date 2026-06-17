# `ax profile interview` - User-Authored Profile Highlights - Design

Date: 2026-06-17
Status: approved (brainstorm), pending implementation plan

## Goal

Give the public ax profile a **user-authored qualitative layer** alongside its
measured metrics. The profile today is all mined/mechanical (sessions, tokens,
charts, radar, derived taste patterns). It captures **zero** of the "I'm
genuinely proud of this" layer - e.g. a user's `instructions-loader.sh` that
injects similar past code into context before work. That is the content that
makes someone *want* to share a profile and what others actually *learn* from,
and the graph cannot mine it - only the person can tell it.

An agent-driven interview runs inside the user's own coding harness (which
already has their ax graph in context), drafts candidate highlights from the
graph + dotfiles, confirms them with the user, captures free-form philosophy,
and writes a local highlights file that `ax profile publish` folds into the
gist. The site renders it inside the existing **Taste** section.

Two user perspectives this serves: (1) "can I look at others' profiles and
learn something?" (2) "am I proud enough to share this?".

## Principles

- **Harness-native.** The interview runs *inside* the coding agent, grounded in
  the real setup - not a bolt-on chatbot. That is ax's edge.
- **Mirror the existing brief → publish loop.** `ax wrapped` already does
  agent-authored content via a copyable brief → agent mines → validated publish.
  This is the same shape, extended to be two-way (the agent interviews the user).
- **Clean provenance.** User-authored content (`highlights`) stays a separate
  block from mined content (`taste.patterns`) on the artifact. They are only
  *rendered* together. The render unifies; the data does not.
- **User-authored → timeless.** Highlights are not window-bound and are never
  cleared by a republish. Re-run the interview to refresh them.
- **Aggregates + user prose only.** No transcript content, project paths, or
  derived private data. The free-text fields are the user's own words.

## Decisions locked (via brainstorming)

- **Own PR**, after the chart/profile work landed (PRs #523, #527 - done).
- **Four capture types:** setup highlights, per-skill summaries, taste /
  philosophy (free-form), wins / shipped.
- **Submit seam:** a validated `ax profile interview submit` command (reads
  JSON from stdin, validates against an Effect schema, writes the file) - NOT a
  raw agent file-write. Mirrors `ax wrapped publish`; schema-checked,
  layer-testable.
- **Interview style:** **draft-then-confirm.** The agent scans the graph +
  dotfiles/hooks, drafts candidate setup highlights / per-skill summaries /
  corroboratable wins, then asks the user to confirm/correct/add - and asks
  open-ended for taste/philosophy and any secret weapon it missed. Fewer turns,
  grounded, user still authors the voice.
- **Render home:** **everything folds into the existing Taste section.** Their
  words on top, then secret weapons, then per-skill summaries, then wins, then
  the mined `taste.patterns` cards below a divider. One home for everything
  taste-flavored.

## 1. Data shape

### Highlights file - `~/.ax/profile-highlights.json`

```jsonc
{
  "v": 1,
  "authored_at": "2026-06-17T19:04:00Z",   // stamp; persists across republishes
  "setup": [                               // secret-weapon rigs/hooks/scripts
    {
      "title": "instructions-loader.sh",
      "what": "Injects similar past code into context before I start work.",
      "why": "Stops re-deriving what I already solved last week.",
      "link": "https://github.com/necmttn/dotfiles/.../instructions-loader.sh"  // optional
    }
  ],
  "skills": [                              // per-skill agent-authored "learn more"
    { "name": "tdd", "source": "superpowers", "summary": "Red-green-refactor loop; tests before code." }
  ],
  "taste": "I optimize for landed-clean commits, not wall-clock. Plan first, route mechanical work to cheaper models, keep judgment on the strong one.",
  "wins": [                                // specific shipped things, graph-corroborated
    { "text": "Bespoke head-to-head duel page", "evidence": "PR #527 · 12 sessions" }  // evidence optional
  ]
}
```

- `setup[]`: `{ title, what, why, link? }`. The "proud to share" layer.
- `skills[]`: `{ name, source, summary }`. `source` matches the rig aggregation
  key (`source + name`) so a summary attaches to the right skill in render.
- `taste`: a single free-form string - how you work / what you optimize for.
  This is the same axis as the mined Taste patterns and renders as the section
  lede.
- `wins[]`: `{ text, evidence? }`. `evidence` is a short human corroboration
  string (e.g. "PR #527 · 12 sessions"), drafted by the agent from the graph.
- All four sub-blocks are independently optional - a partial interview is valid
  (e.g. taste blurb only).

### `ProfileV1` extension

Add an optional `highlights` block (`apps/axctl/src/profile/schema.ts`):

```ts
const Highlights = Schema.Struct({
    authored_at: Schema.String,
    setup: Schema.optional(Schema.Array(Schema.Struct({
        title: Schema.String,
        what: Schema.String,
        why: Schema.String,
        link: Schema.optional(Schema.String),
    }))),
    skills: Schema.optional(Schema.Array(Schema.Struct({
        name: Schema.String,
        source: Schema.String,
        summary: Schema.String,
    }))),
    taste: Schema.optional(Schema.String),
    wins: Schema.optional(Schema.Array(Schema.Struct({
        text: Schema.String,
        evidence: Schema.optional(Schema.String),
    }))),
});

// in ProfileV1:
highlights: Schema.optional(Highlights),
```

The file artifact is the same shape with a leading `v: Schema.Literal(1)`. A
dedicated `Highlights` schema (with `v`) is the validated submit target; the
`ProfileV1.highlights` field drops `v` (the profile carries its own `v`).

## 2. CLI - `apps/axctl/src/cli/commands/profile.ts`

Two new subcommands under the existing `profile` command, mirroring
`ax wrapped`:

### `ax profile interview`

Writes `.ax/tasks/profile-interview-<date>.md` - a brief instructing the agent
to interview the user and submit the result. The brief is **pre-filled from the
graph** so the agent starts grounded:

- Top skills from the rig (so it can draft per-skill summaries) - composed from
  the same query the profile renderer uses (`skills weighted` / rig).
- Candidate setup weapons: installed hooks (`~/.ax/hooks/*.ts`), routing table
  presence, and a hint to scan the user's dotfiles/scripts dirs.
- Corroboratable wins: recent landed commits / churn in the window.

The brief instructs the agent to:
1. Draft candidate setup highlights, per-skill summaries, and wins from the
   above.
2. Show the drafts to the user; ask to confirm / correct / add - and ask
   open-ended for taste/philosophy and any secret weapon it missed.
3. Emit the final highlights as JSON through
   `echo '<json>' | ax profile interview submit`.

`--force` overwrites an existing brief for the date (mirrors
`ax wrapped generate`). Brief renderer is a pure function
(`renderProfileInterviewBrief({ date, skills, hooks, ... })`) → string, so it is
unit-testable; the IO (graph queries, file write) stays in the command.

### `ax profile interview submit`

Reads `{ ...highlights }` JSON from stdin (or `--file=PATH`), validates against
the `Highlights` Effect schema, stamps/normalizes `authored_at` if absent, and
writes `~/.ax/profile-highlights.json`. Mirrors `ax wrapped publish` exactly.
On success prints a confirmation and the hint to run `ax profile publish`.
Invalid JSON or schema-mismatch fails loudly (never writes a partial file).

Path helper + load/validate live in a small `profile/highlights.ts` module
(default path `~/.ax/profile-highlights.json`, `AX_DATA_DIR`/`HOME`-derived),
so both `submit` and `buildProfile` share one loader - no second path literal.

## 3. Publish fold-in - `apps/axctl/src/profile/render.ts`

`buildProfile` reads the highlights file (if present) via the shared loader,
validates it, and attaches it as `ProfileV1.highlights`. A missing or unreadable
file is a silent no-op (profile renders without the block - today's behavior).

The existing **publish consent gate** already prints the full profile JSON
before the first publish, so the user sees exactly what leaves the machine
(including all highlights text). `--no-cost` is unaffected. The watcher's
`ax profile publish --if-stale=2h` carries highlights forward automatically
because the file persists (the renderer re-reads it each build).

No new consent step: highlights are user-authored prose, surfaced verbatim in
the existing full-JSON gate. Setup `link` may be a private repo URL - the user
authored it and sees it in the consent JSON; no scrub (consistent with the
taste-summary policy in the profiles spec §6).

## 4. Site render

### Validator - `apps/site/app/lib/community.ts`

Extend `ProfileV1` (the site's manual interface) with the `highlights` shape and
validate every rendered field in `validateProfileV1` - strings via `str`,
optional via `optStr`, arrays guarded with `Array.isArray`. Per the file's
contract: any field rendered as a JSX child MUST be validated here, or a hostile
gist value could only ever render as text. `link` is validated as a string and
rendered with `rel="noopener nofollow"` + scheme check (http/https only) - never
trusted as a raw href without guarding the scheme.

### Component - `apps/site/app/components/profile-dossier.tsx`

The existing Taste section (`eyebrow="taste"`) becomes the single home. Render
order inside it:

1. **Their words** - `highlights.taste` as a section lede (quote styling).
2. **Secret weapons** - `highlights.setup[]` as cards (`title`, `what`, `why`,
   optional outbound `link`).
3. **Learn the rig** - `highlights.skills[]` as `name (source) - summary` rows.
4. **Shipped this window** - `highlights.wins[]` as checked rows with optional
   `evidence` tail.
5. **Patterns ax keeps seeing** - the existing mined `taste.patterns` cards,
   below a divider, labeled as mined/evidence-grounded.

Section renders whenever `highlights` OR `taste.patterns` is present.
Empty-state preserved: no interview run → only the mined patterns show (exactly
today's behavior). The section is part of the shared `ProfileDossier`, so it
appears on both `/u/<login>` and the `/u/<a>/vs/<b>` duel route with no extra
wiring.

## 5. New-subcommand gates

Per repo convention (memory `memory-ops-shipped`), register the new subcommands
in all of:

- `cli.md`
- `llms.txt`
- `cli-reference.data.ts`
- `VISIBLE_COMMANDS`

Both `ax profile interview` and `ax profile interview submit` are documented.

## 6. Testing

- **`Highlights` schema** (`profile/schema.test.ts` or a new
  `highlights.test.ts`): decode good fixtures + reject bad ones (missing
  required field, wrong type); partial-block fixtures (taste-only) decode.
- **Brief render**: pure-function string test -
  `renderProfileInterviewBrief({...})` includes the pre-filled skills/hooks and
  the `submit` instruction. No DB.
- **`submit`**: validates + writes via the shared loader; bad JSON fails without
  writing. Use the `AX_DATA_DIR`/path seam (or a spawnSync CLI test against a
  temp dir) - no real `~/.ax` writes in tests.
- **`buildProfile` fold-in**: fixture highlights file → profile carries the
  `highlights` block; absent file → no block, no error.
- **Site**: source-grep test (e.g. assert the dossier references `highlights`
  fields and the validator guards them). Do NOT write a render test that pulls
  the `~/` alias chain - repo-root `bun test` has no tsconfig-paths plugin and
  it would fail CI `verify` (handoff gotcha; cf. `profile-duel.test.tsx`).

## Gotchas (from the handoff / memory)

- `root-tsconfig-sweeps-web-packages`: root `tsc` typechecks `packages/**/*.ts`
  under CLI config (no DOM). The site is an app, not a package, so this is not
  triggered here - but any new web/React code must follow the
  `@jsxImportSource react` + exclusion convention if it lands under `packages/`.
- Repo-root `bun test` cannot resolve the apps/site `~` alias - use relative
  imports or source-grep tests for any apps/site test.
- Multi-agent repo: branch = claim; create a worktree (`bun run wip claim` or
  `git worktree add`), never work on `main`. Merge only at
  `mergeStateStatus: CLEAN`; expect to merge `origin/main` and resolve
  `globals.css` / `profile-dossier.tsx` conflicts before going green. CI
  `verify` (repo-wide `bun test`) + the Cloudflare Pages build are the real
  gates for apps/site.

## Out of scope (v1)

- No per-field publish confirmation beyond the existing full-JSON consent gate.
- No editing UI in the studio - the interview is harness-native only.
- No cross-user aggregation of highlights (community compile untouched).
- No auto-derivation of the `taste` blurb - it is the user's own words by design.
- No image/media in highlights - text + an optional outbound link only.
