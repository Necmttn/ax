# Challenge share-card - design (Phase A)

Date: 2026-06-16
Status: approved for plan

## Problem

ax profiles publish, but spread passively. The only way to invite a teammate
is to send them a raw `/u/<login>` link. Profile comparison already exists
(`/u/<login>?vs=<other>` radar overlay + raw-values "who-leads" table), but:

- the URL shape is unbrandable (`?vs=` query param, not a path);
- nothing on a profile page *prompts* anyone to share or challenge;
- an unregistered challenger gets no targeted "fight back" hook;
- pasted links unfurl with a generic OG image, so the duel is invisible until click.

Goal: turn a published profile into a paste-able dare. The link shows you
winning; the empty challenger slot says "publish to fight back." **Zero team
infrastructure** - challenges are pairwise, by URL.

## Scope

In scope (Phase A):

1. Canonical compare route `/u/<a>/vs/<b>`.
2. Unclaimed-challenger page state.
3. CLI publish hint line.
4. Duel OG unfurl image (stat-bars, no radar).
5. Challenge + share block on every profile page.

Explicitly deferred:

- **Team boards (Phase B)** - any `/leaders`-style team grouping. ax has no
  backend/auth; team identity (self-tag vs team-file vs gh-org) is unresolved
  and gated on whether the challenge loop converts at all. Revisit after A.
- Brag-hook callouts and a dedicated answer-the-challenge CTA on the
  unclaimed/compare pages - folded out of v1; the encouragement lives on the
  personal profile page only (see §5).
- An `ax profile challenge <login>` subcommand - the publish hint line covers it.

## Constraints (the shape of the system)

- **No backend, no auth.** Everything is data-only: `community/users/<login>.json`
  = `{github, gist_id, joined}`, auto-merged by bot; nightly compiles
  `leaderboard.json`. A profile page cannot know whether the viewer is the owner.
- **Site is effect-free.** `apps/site` does not depend on `effect`; community
  validation is manual (`apps/site/app/lib/community.ts`).
- **Satori cannot render raw SVG** (see memory `og-satori-parser-quirks`). The
  duel OG image must avoid the radar polygon.
- Logins are sanitised everywhere through the existing `LOGIN_RE`
  (`/^[A-Za-z0-9-]{1,39}$/`).

## Components

### 1. Canonical compare route - `/u/<a>/vs/<b>`

New file route `apps/site/app/routes/u.$login.vs.$other.tsx`. A **thin
wrapper**, not a fork of the dossier renderer:

- Resolves `login` (= `a`) and `other` (= `b`), both validated via `LOGIN_RE`.
- Self-compare guard: if `b.toLowerCase() === a.toLowerCase()`, **redirect** to
  `/u/<a>` (plain profile). No self-overlay on the path form.
- Otherwise renders the **same** `ProfileDossier` from `u.$login.tsx` with the
  vs-peer preset to `b` - reuses the existing `?vs=` overlay machinery (radar
  series + `RawTable` who-leads). To share render logic, extract `ProfileDossier`
  + its `VsState` helpers into a shared module
  (`apps/site/app/components/profile-dossier.tsx`) imported by both routes; the
  two route files stay thin (param resolve + state fetch).
- `/u/<a>?vs=<b>` keeps working (back-compat); the path form is canonical for
  sharing. Optionally the query form sets a canonical link rel to the path form.

### 2. Unclaimed-challenger state

When `/u/<a>/vs/<b>` resolves and `b` is **not registered** (gist fetch
`notFound`): render `a`'s full dossier, leave `b`'s radar/table column empty,
and stamp the sign section with `challenge issued · @b hasn't answered`, plus
the `ax profile publish` command beneath. Extends the existing `UnclaimedDossier`
(`u.$login.tsx:933`) into a vs-aware variant (`UnclaimedChallenger`), reusing
its copy/stamp styling. This is the only genuinely new on-page UI besides §5.

Edge cases:
- `a` unregistered → existing `UnclaimedDossier` for `a` (the primary subject
  must exist for a duel to mean anything); ignore `b`.
- both unregistered → treat as `a` unregistered.

### 3. CLI publish hint line

`ax profile publish` already prints the profile URL (commit `91def51e`). Append
one line after it:

```
challenge a colleague → ax.necmttn.com/u/<you>/vs/<their-handle>
```

`<you>` is the just-published login; `<their-handle>` stays a literal placeholder
(no network, no guessing). Hint only - no new subcommand. Lives wherever the
post-publish URL print is emitted in `apps/axctl/src/.../profile` publish path.

### 4. Duel OG image - `/og-duel/<a>/<b>`

New CF Pages Function `apps/site/functions/og-duel/[a]/[b].ts`, sibling of
`og-profile/[login].ts`, reusing `functions/_lib/og-kit.ts` + `og-meta.ts`.

- Header: `@a vs @b`.
- Body: two stat ledgers **side by side** (sessions / tokens / spend / streak -
  whatever `og-profile` already shows per profile), plus a **lead tally**
  (`@a leads 4 of 6 · @b leads 2 of 6`) derived from the same per-axis
  comparison the page's `RawTable` uses (shared via `app/lib/radar.ts`
  `profileToAxes` + the lead rule).
- **No radar** - satori can't draw the polygon. Bars + lead count read as a duel
  and unfurl cleanly. The real radar lives on the click-through page.
- The `/u/<a>/vs/<b>` route's `head()` points `og:image` at `/og-duel/<a>/<b>`.
- Unregistered `b`: render `a`'s ledger + an "unclaimed challenger" half so the
  unfurl still works as a dare.

### 5. Challenge + share block (every profile page)

One block on every `/u/<login>` page (the encouragement layer). Because the page
cannot know the viewer, a single input serves both readings:

> **Think you out-ship @<login>?** → `[ your github handle ] [ challenge → ]`

- Owner viewing own page reads it as "challenge a colleague" (types a teammate).
- Visitor reads it as "challenge the owner" (types themselves).
- Submit mints `/u/<entered-handle>/vs/<login>` and navigates / copies it.

This is the existing quiet `pf-sign-compare` form (`u.$login.tsx:451`) **promoted**
to a louder standalone block. After a comparison is active, add two buttons:

- **copy duel link** - copies the canonical `/u/<a>/vs/<b>` URL.
- **post on X** - opens an X intent prefilled with the lead tally, e.g.
  `@a leads @b on 4 of 6 axes - think you can beat us? <url>`.

Copy uses `navigator.clipboard` with a graceful fallback (select-text) for
non-secure contexts.

## Data flow

```
ax profile publish ──prints──▶ /u/<you>  +  hint: /u/<you>/vs/<them>
        │
visitor opens /u/<a>/vs/<b>
        │  fetchProfile(a), fetchProfile(b)        (existing community.ts path)
        ├─ b registered    ▶ ProfileDossier(a, vs=b)  → radar overlay + who-leads
        ├─ b unregistered  ▶ UnclaimedChallenger(a, b)
        └─ b == a          ▶ redirect /u/<a>
        │
   head() og:image ▶ /og-duel/<a>/<b>  (satori: ledgers + lead tally, no radar)
        │
   on-page block ▶ mint /u/<x>/vs/<login>  +  copy-link / post-on-X
```

## Testing

- `LOGIN_RE` rejection + self-redirect: unit test the route's param/redirect
  logic (extract the decision to a pure helper).
- Lead-tally derivation: pure function over two `RadarAxes`, unit-tested
  (mirrors existing `RawTable` leader rule - share one helper, test it once).
- OG function: extend the `og-profile` test pattern in `functions/_lib/*.test.ts`
  - assert the duel function returns an image response for registered/registered,
  registered/unclaimed, and rejects bad logins.
- Manual: paste a `/u/<a>/vs/<b>` link into X/Slack, confirm the duel unfurl.

## Open questions

None blocking. (Phase B team identity is deferred by decision, not unresolved
within this scope.)
