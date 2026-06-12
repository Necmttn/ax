# ax Profiles, Community Fork Rails & Leaderboards - Design

Date: 2026-06-12
Status: approved (brainstorm), pending implementation plan

## Goal

Give every ax user a shareable, auto-updating public profile (stats + agent
rig) hosted at `/u/<github-login>` on the ax site, plus multi-board
leaderboards at `/leaders` - using only GitHub primitives (gists, forks, PRs,
Actions). The contribution mechanism doubles as the growth engine: users
register by fork+PR into `Necmttn/ax` itself, so every signup grows forks,
contributors, and network-feed broadcasts.

## Principles

- **No owned servers.** Gists + repo files + GitHub Actions + CF Pages static
  reads. A Cloudflare Worker is a named v2 option only (see Deferred).
- **Two planes.** Control plane = one-time fork+PR registration into the main
  repo. Data plane = user-owned gist updated in-place. Profile updates never
  require PRs.
- **Aggregates only.** Never transcript content, project names, or paths.
- **Fork as standing contribution vehicle.** The same fork rails serve
  profile registration, skill/hook contributions, and fixes - friction is
  removed before motivation appears.

## 1. Data shape

### Gist (data plane)

One gist per user, file `ax-profile.json`, updated in-place via
`gh api PATCH /gists/:id` (same update-in-place approach ax share needs).

```jsonc
{
  "v": 1,
  "github": "necmttn",
  "generated_at": "2026-06-12T19:04:00Z",
  "window_days": 30,
  "stats": {
    "sessions": 142,
    "active_days": 26,
    "streak_days": 12,
    "tokens": { "prompt": 31000000, "completion": 7000000, "total": 38000000 },
    "cost_usd": 214.30,                      // omitted when --no-cost
    "models": [{ "name": "fable", "share": 0.58, "cost_usd": 124.0 }],
    "harnesses": ["claude-code", "codex"]
  },
  "rig": {
    "skills": [{ "name": "tdd", "source": "superpowers", "runs_30d": 88 }],
    "hooks": ["enforce-worktree", "route-dispatch"],
    "routing_table": true
  },
  "taste": {
    "patterns": [
      {
        "category": "failure-mode",
        "name": "edit-loop-thrash",
        "summary": "3+ edits to same file → stop, re-read requirements",
        "evidence": { "sessions": 12, "confidence": 0.8 },
        "links": [
          { "rel": "recovered-by", "ref": "problem-solving-strategy/full-file-reread" }
        ]
      }
    ]
  }
}
```

- `source` is mandatory on skills - aggregation key is `source + name`
  (`superpowers:tdd` ≠ local `tdd`); prevents plugin/local collisions.
- Renderer lives in `apps/axctl/src/profile/` and composes existing queries
  (`cost models`, `skills weighted`, sessions/streaks). Pure function from
  query rows → profile JSON; snapshot-testable.

### Taste section (metapatterns)

The profile's third axis beyond stats (volume) and rig (inventory): the
user's *taste* - composable metapatterns other agents can consume. Three
constraints shape it:

- **Closed category enum (v1):** `design-aesthetic` |
  `problem-solving-strategy` | `debugging` | `failure-mode` | `workflow`.
  Constraints make patterns organizable, navigable, composable; free-text
  categories would fragment aggregation. New categories extend the enum
  deliberately. AI-created groupings happen at *derivation* time
  (classifier/improve output), not at the type level.
- **Linkable patterns:** `links[].rel` (`recovered-by`, `pairs-with`,
  `conflicts-with`) + `ref` = `category/name`. Failure-modes linked to
  recovery strategies are the cross-agent payoff: one agent's failure mode
  resolves against another agent's proven recovery pattern.
- **Evidence-grounded:** `evidence.sessions` + `confidence` separate observed
  taste from aspiration, and give aggregation an anti-junk signal.

v1 scope: schema + site rendering ship; entries derive from existing
`ax improve` proposals / classifier output where present, section omitted
otherwise. Cross-user pattern matching (`pattern-stats.json`, joining
failure-modes to recovery strategies across users) is deferred to v2.

### Repo (control plane)

`community/users/<github-login>.json` - one-time registration pointer:

```json
{ "github": "necmttn", "gist_id": "abc123", "joined": "2026-06-12" }
```

Identity proof: CI requires PR author == `github` field == filename.

## 2. CLI

- `ax profile publish [--window=30] [--no-cost]`
  - Render profile JSON from local SurrealDB.
  - First run: print the exact JSON to be published, confirm y/N once, then
    create gist; `gh repo fork Necmttn/ax`; commit
    `community/users/<login>.json` via GitHub API (blob/tree/commit - no
    local clone, zero disk); open registration PR.
  - Subsequent runs: PATCH gist in place. `--if-stale=6h` reads remote
    `generated_at` and no-ops when fresh (cheap; used by automation).
- `ax profile show [--json]` - local preview, no publish.
- `ax profile unpublish` - delete gist; open PR removing registration file.
- `ax contribute skill <name>` / `ax contribute hook <file>` - v1 thin: copy
  artifact + metadata onto a branch in the user's existing fork, open PR into
  `community/skills/` / `community/hooks/`. No registry semantics yet.
- `ax contribute pattern` - picker over the user's own profile
  `taste.patterns` to promote one to `community/patterns/<category>/<name>.json`
  via the same fork rails; authoring fresh goes through schema-validated
  structured prompts (never a blank editor). Lowest-friction contribution
  unit - the gateway to skills/hooks contributions. No free-form tips dir:
  tips ARE patterns (see 3c).

All GitHub operations (gist CRUD, fork, remote commit, PR) go through a
`GitHubEnv` Effect service (mirrors hooks-sdk `GitEnv`) so commands are
layer-testable without network.

## 3. Repo side (Necmttn/ax)

### 3a. Registration validation + auto-merge

Workflow `community-users.yml` on PRs touching `community/users/*.json`:
- JSON schema validation (strict; unknown fields rejected).
- PR author == `github` field == filename.
- PR touches nothing else → label `community-registration` → auto-merge
  (`gh pr merge --squash` in the action). Any other path touched → no
  auto-merge, human review.

### 3b. Nightly aggregation compile

Nightly Action walks `community/users/*.json`, fetches each gist
(ETag/`If-None-Match` to skip unchanged), and emits three compiled files,
committed only when changed:

```
community/leaderboard.json    // all boards precomputed: tokens, sessions, streak, cost
community/skill-stats.json    // { "superpowers:tdd": { "users": 41, "runs_30d": 2210, "trend_pct": 12 } }
community/hook-stats.json     // { "enforce-worktree": { "users": 17 } }
community/state/<year>.json   // anonymized distributions: model share, harness mix,
                              // cost percentiles, skill/hook adoption, taste-pattern frequency
```

- Aggregation key for skills/hooks: `source + name`.
- Anti-troll: schema-invalid rows dropped; absurd values (tokens above a sane
  cap) flagged and excluded from boards.
- Scale: N users = N conditional gist fetches nightly; GITHUB_TOKEN rate
  limits comfortably cover thousands of users before sharding is needed.

### 3c. Community contributions

`community/skills/` and `community/hooks/` PRs follow the normal
human-reviewed flow. Adoption stats from 3b can badge their READMEs.

`community/patterns/<category>/<name>.json` - shared tips/tricks as
structured patterns, same schema as a gist `taste.patterns` entry. Messiness
controls are mechanical, not editorial:

- Closed category enum only - no free tags.
- CI schema validation (same machinery as registration PRs).
- Dedupe by filename: a collision forces engaging the existing pattern
  (extend or `links[]` it) instead of duplicating.
- `evidence` distinguishes measured patterns from drive-by opinion.
- GitHub reactions on merged pattern PRs = lightweight quality signal later.

One pattern schema everywhere: gist (personal taste), `community/patterns/`
(shared), `state/<year>.json` (distribution). Prose-length tricks that need
paragraphs belong in blog posts/discussions, not the registry - intentional
non-goal.

## 4. Site (apps/site)

- `/u/<login>` - client-side fetch of the user's gist raw URL (CORS-safe),
  render stats + rig. Always fresh (no compile lag). 404 when unregistered.
  Includes "powered by ax" link, copyable install command, fork CTA.
- `/leaders` - reads compiled `leaderboard.json` via raw.githubusercontent.
  Tabs: Tokens · Sessions · Streak · Cost (+ Trending Skills board from
  `skill-stats.json`). Rows link to `/u/<login>`. Banner shows compile
  timestamp; self-reported nature stated on page.
- `/skills/<source>:<name>` - adoption page ("used by 41 devs, 2.2k runs/30d")
  driven by `skill-stats.json`. Stretch within v1 if cheap; else first v2 item.
- `/patterns` - browsable community patterns by category (failure-modes with
  linked recoveries, strategies, workflows); each links its author's
  `/u/<login>`.
- All gist-sourced strings escaped; nothing from user JSON is interpreted as
  HTML.

## 5. Automation

- **Client:** watcher (`com.necmttn.ax-watch`) post-ingest hook runs
  `ax profile publish --if-stale=6h` after a successful ingest - profile
  refreshes whenever the user codes. Debounce lives inside the command.
- **Fallback:** `ax install` registers a daily LaunchAgent timer for machines
  where the watcher misses. Publish remains explicit opt-in (interactive
  first run); `ax doctor` mentions profile status.
- **Server:** nightly compile Action (3b). No owned infrastructure anywhere.

## 6. Privacy & security

- Cost is public by default (decision); first publish shows the exact JSON
  and requires confirmation; `--no-cost` exists from day one;
  `ax profile unpublish` is a single command.
- Aggregates only - enforced by the renderer's output type, not by filtering
  at the edge.
- Compiled boards validate schema and drop malformed/absurd rows.
- Numbers are self-reported and gameable; accepted for v1 and stated on
  `/leaders`.
- Site escapes everything sourced from gists or compiled JSON.

## 7. Testing

- Profile renderer: pure-function snapshot tests against fixture DB rows
  (bun:test, existing patterns).
- `GitHubEnv` service: layer-mocked in tests - gist CRUD, fork, remote
  commit, PR open are all verified without network.
- CI validator: fixture good/bad registration PR payloads.
- Nightly compiler: fixture gist sets → expected leaderboard/skill-stats
  output; ETag short-circuit covered.
- Site: profile + leaderboard components rendered against fixture JSON.

## Growth mechanics (why fork+PR, not a second repo)

1. Merged registration PR broadcasts "X contributed to Necmttn/ax" to the
   user's follower feeds - distribution per signup.
2. Contributors count and fork count on the repo header grow with every user.
3. A user with an existing fork + authenticated rails is one command away
   from a real contribution (skill, hook, fix).
4. `community/` becomes a browsable directory (awesome-list dynamic).
5. PR-merge activity → profile visits → stars → trending math.

## Deferred (v2)

- README profile widget (marker-delimited block in `username/username`,
  wakatime-style) and SVG stats card.
- Cloudflare Worker as cache/freshness layer in front of compiled JSON -
  only if real-time counts, browser fan-out caching, or Action rate limits
  demand it. It would cache, not replace, the compile.
- `ax contribute` registry semantics (versioning, install counts, reviews -
  see parked registry+mesh design).
- `pattern-stats.json` in the nightly compile: cross-user taste aggregation,
  joining one user's failure-modes to recovery strategies proven by others
  (the registry+mesh wedge).
- Sharded `community/users/<a>/<name>.json` layout past ~10k users.
- `/state/<year>` report page - "State of Agent Engineering", stateofjs-style
  scrolly report rendered from `community/state/<year>.json`. Differentiator
  vs survey-based State of AI (stateofai.dev, Devographics): measured
  telemetry, not self-reported answers - actual model split, token spend,
  skill adoption curves, failure-mode frequency. Distributions compile from
  day one (above); the report page ships when user count makes the headline
  credible. Optional survey layer later for opinion questions telemetry
  cannot answer; a Devographics pairing (their survey + our telemetry) is a
  possible collab.

## Open questions

- Streak definition: calendar days with ≥1 session, local timezone vs UTC -
  pick at implementation (lean UTC for comparability).
- Auto-merge bot account vs GITHUB_TOKEN permissions for squash-merge - needs
  a quick permissions spike.
- `/skills/<name>` in v1 or first v2 item - decide at planning by remaining
  budget.
