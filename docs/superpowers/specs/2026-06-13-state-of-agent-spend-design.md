# State of Agent Spend - Measured, Not Surveyed - Design

Date: 2026-06-13
Status: approved (brainstorm + grill), pending implementation plan
Related: [2026-06-12-ax-profiles-design.md](./2026-06-12-ax-profiles-design.md),
parked registry+mesh design (memory `ax-registry-mesh-design`)

## Origin

Competitive recon on [aistack.to](https://aistack.to) ("Like Stackshare but
for AI", repo `alp82/aistack`) started this as a "steal their profile hero +
clone loop" spec. Grilling moved it up a level:

- **Clone loop: cut.** Their `npx collect`/`create` moves static config files
  between strangers - a dotfiles copy. ax's edge is *showing what works with
  receipts*, not installing a stranger's rig. `/u/<login>` stays an
  inspect-and-decide surface; no install command. (Team-ring rig sharing, if
  ever, is committed `.ax/` in a shared repo - a different, later thing.)
- **The real competitor is the survey.** aistack shows one self-reported
  profile at a time; `stateofai.dev` / Devographics State-of-X reports ask
  people what they use. **The entire genre is self-reported.** ax reads N
  engineers' actual transcripts. That is the whole pitch and nobody in the
  category can copy it.

## Goal

A measured **"State of Agent Spend"** report at `/state/<year>` - the
collective, evidence-backed answer to what AI engineers actually pay, route,
run, and recover from - built only from data ax already ingests, on the
profiles rails already shipped. No owned servers; aggregates only.

The per-profile hero at `/u/<login>` is **the unit that feeds it and the
share artifact that grows it** - not a side feature. It ships first because
it is the only lever that grows registrations, and `/state` is vaporware
until registrations climb.

## Principles

- **Measured, never surveyed.** Every number traces to ingested transcripts.
- **No owned servers.** Gists (data plane) → nightly GitHub Action compile →
  `community/state/<year>.json` → CF Pages static read. Same rails as
  `/leaders`.
- **Aggregates only.** Cross-user output carries distributions and shares,
  never another user's transcript content, paths, or project names. Per-user
  numbers appear only on that user's own `/u` page (already public, consented
  at publish).
- **Hero-first sequencing is forced, not chosen.** A collective page needs a
  population; the hero is what creates it.

---

## Build sequence (one spec, three sequenced plans)

Each stage is its own implementation plan. **We do not plan stage 3 until
stage 1 ships and real N is visible.**

### Stage 1 - Per-profile hero (ships first, works at N=1)

The share-on-X artifact and registration driver. Mostly presentation over
data already in `ProfileV1` (`apps/axctl/src/profile/schema.ts`:
`stats.cost_usd`, `stats.models[]`, `rig.*`). **No gist schema change for the
core hero.**

- **Headline `$/mo`, mirror-and-beat.** Where aistack hand-types `$256/mo`
  from a screenshot, ax renders **`~$214/mo · measured from 142 sessions`**
  with the window stated inline. Spend is the number they fake and ax proves
  - out-receipting them on their own metric is the sharpest jab. Provenance
  subline `measured from N sessions over Wd · not a screenshot` ships in the
  hero, not a footnote.
- **Stat row** above the radar/dossier, mirroring their four-stat layout:
  `$/mo · tools · models · sessions`. Promote the existing mid-page
  `est. spend` vital into this row.
- **`--no-cost` profiles** hide the `$/mo` slot and lead with sessions; the
  row must read correctly with cost absent (existing gist option).
- **OG card** (`functions/og-profile/[login].ts`) mirrors the stat row so the
  shared image carries the number. Verify rendered figures against real
  `ax profile show` output (OG satori quirks memo applies).
- **Tool takes: derived, with optional manual override.** Lead with existing
  `ProfileV1` `stack-choice` patterns (`slot`, `name`, `over[]`, `context`)
  rendered as the tool blurbs - taste *earned from evidence*, the on-thesis
  answer to aistack's hand-typed tool cards. Allow an optional one-line
  manual override per tool where the data is thin: additive optional
  `rig.skills[].note` (≤140 chars), run through the same scrub the publish
  path already applies to taste prose. Manual is the exception; derived is
  the default.

### Stage 2 - Nightly aggregate compile (once N climbs)

Extend the existing compile (`scripts/compile-community.ts`, the Action that
already builds `leaderboard`/`skill-stats`) to emit
`community/state/<year>.json`. ETag-cached, absurd rows dropped, schema
validated - identical posture to the current compile.

Aggregates produced:
- **Spend distribution** - median, p90, histogram bands of `stats.cost_usd`
  (window-normalised to /mo).
- **Model split** - token-weighted share across `stats.models[]`.
- **Rig leverage** - skill run-share across `rig.skills[].runs` (what *ran*,
  not what was installed).
- **(v1.1) Failure→recovery rates** - see §4 below; needs a new compiled
  `pattern-stats.json` and is explicitly deferred past the first `/state`
  cut.

### Stage 3 - `/state/<year>` render (centerpiece, gated on non-embarrassing N)

A scrolly report route reading the compiled JSON via CF Pages static fetch.
Sections:

- **§1 What people pay** - spend distribution (the legible hook that earns
  the click). The aistack number, collective and measured.
- **§2 Model routing in the wild** - the fable/opus/sonnet/haiku split.
  aistack's top profile hand-writes this; ax aggregates it from the same data
  `ax dispatches` reads.
- **§3 What rigs actually fire** - skill-leverage bars.
- **§4 Failure → recovery rates** *(v1.1, north-star section)* - "X% of
  edit-loop-thrash episodes recovered within 3 turns." **The section no
  survey can ask** - ax's deepest moat and the reason the genre is
  uncopyable. Deferred from the first cut only because the cross-user
  recovery aggregate (`pattern-stats.json`) does not exist yet; the first
  `/state` ships §1-§3 and §4 lands as soon as that compile does.

---

## Data flow

```
per-user gist (ax-profile.json)          data plane - shipped
        │  nightly GitHub Action (compile-community.ts, extended)
        ▼
community/state/<year>.json              new aggregate artifact (stage 2)
        │  CF Pages static read
        ▼
/state/<year>  scrolly report            new centerpiece route (stage 3)
/u/<login>     hero + derived takes       the unit + share artifact (stage 1)
```

## Privacy & security

- Inherits the profiles spec posture wholesale. Cross-user output is
  aggregate-only, enforced by the compiled artifact's output type.
- Per-user spend is already public/consented on `/u`; the aggregate adds no
  new disclosure.
- Manual tool-note input (stage 1) goes through the existing publish-path
  scrub before it reaches the gist.
- Numbers are self-published-but-measured: gameable at the edge (a user could
  publish a doctored gist), accepted for v1 and stated on `/state`. Absurd
  rows dropped in compile, same as `/leaders`.
- Site escapes everything sourced from gists or compiled JSON.

## Testing

- Stage 1: hero derivation is a pure function - snapshot tests against
  fixture `ProfileV1` rows (existing profile-renderer pattern). OG card
  rendered against fixtures. `--no-cost` path covered.
- Stage 2: fixture gist sets → expected `state/<year>.json`; ETag
  short-circuit and absurd-row drop covered (mirror existing compile tests).
- Stage 3: `/state` components rendered against fixture compiled JSON;
  empty/low-N state renders honestly.

## Non-goals (v1)

- **`ax rig clone` / any install command** - cut. `/u` is show-not-install.
- Hosting user-authored skill/hook content.
- Per-profile upvotes / social directory mechanics - `/leaders` already
  ranks.
- Changes to the registration/control plane - rides existing fork+gist rails
  untouched.
- A full multi-topic `/state` ("State of Agent Engineering" beyond spend) -
  this spec is spend + routing + rig + recovery only; broader topics stay in
  the profiles-spec Deferred list.

## Open questions

1. **Window normalisation when `window_days` ≠ 30** - show native-window
   total plus a derived `~$X/mo` so the hero headline stays comparable to
   aistack's monthly number? (Lean: yes, derived `/mo` with native total
   beside it.)
2. **`/state` go-live threshold** - what N makes the page non-embarrassing,
   and what does it show below that (a "measuring…" honest empty state vs a
   noindex hold)? Decide at the stage-2/3 boundary with real numbers.
3. **§4 recovery aggregate shape** - what is the unit (episode? session?) and
   the recovery predicate, and does it reuse `ax sessions churn` episode
   logic (failure opens / same-family pass closes / 30min expiry)? Resolve in
   the stage-2 v1.1 plan.
4. **Derived tool-take coverage** - what fraction of a real profile produces a
   usable `stack-choice` take vs falls back to manual? Audit one real profile
   before finalising stage-1 take UX.
