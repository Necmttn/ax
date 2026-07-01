# Goal package - Team dashboard v1: git-native, zero company data in backend

- **Issue:** https://github.com/Necmttn/ax/issues/649
- **Branch:** `plan/649-team-dashboard-v1-git-native-zero`
- **Decided:** 2026-07-01
- **Supersedes:** the deferred hosted-backend slices (4-7) of `docs/superpowers/specs/2026-06-15-team-backend-design.md`

## 1. Problem & re-scope

The commercial team dashboard was gated behind a design-partner price signal because
the spec's hosted backend (slices 4-7) stores per-dev telemetry in **Cloudflare D1**
via **Better Auth** (org + device-authorization plugins). Holding company data in ax's
DB drags in the entire heavy surface: multi-tenant isolation guards
(`requireOrgMember` on every endpoint), org-bound device tokens with rotation/revoke
lifecycle, k-anonymity suppression, pseudonymity framing, right-to-delete, and breach
liability. That is a real product, and it is what made the build scary.

**New hard constraint: ax never stores readable company data.** Telemetry lives in the
**company's own private git repo**; the dashboard aggregates **client-side** in the
viewer's browser using the viewer's own GitHub token. GitHub repo membership becomes the
tenancy boundary - we delete the tenancy/token/anonymity surface almost entirely and can
pilot the moment an inquiry converts.

Storage model locked (2026-07-01, user): **git-native SPA**. Encrypted-R2 is a
documented fallback seam, not built in v1.

## 2. Target architecture

```
dev's local ax
   │  ax team push  (repo-scoped, redacted, daily-collapsed)
   ▼
company PRIVATE git repo
   .ax-team/<login>.json        ← per-dev TeamProfileV1 snapshot
   │  repo membership == team membership  (git owns distribution + auth + tenancy, free)
   ▼
team dashboard SPA (studio /team, hosted or local)
   │  reads via the VIEWER's own GitHub OAuth token → api.github.com/repos/{org}/{repo}/contents/.ax-team/*
   │  aggregates in-browser (reuse community-compile core)
   ▼
adoption + performance boards
```

**Data at rest in ax-owned infra: none.**
Only stateful component: a **stateless OAuth-exchange Worker** that holds the GitHub
OAuth *client secret* and swaps an auth code for a user token. It persists nothing.

Removed vs the old spec: D1, Better Auth org/device plugins, `dev_snapshot` /
`dev_snapshot_history` / `team_device_token` / `team_scope` tables, `requireOrgMember`
tenancy guards, k-anonymity engine. GitHub repo ACL replaces all of it.

### Why client-side private-repo read works
`api.github.com` returns CORS headers for authenticated requests, so a browser holding
the viewer's OAuth token can `GET /repos/{org}/{repo}/contents/{path}` (base64 body) for
any repo the viewer can already read. Private-repo `raw.githubusercontent.com` is *not*
usable from the browser (no auth header on the CDN), so we use the contents API, not raw
URLs - the one deviation from the public community-rails fetch path.

## 3. Reuse map (grounded, from repo scout 2026-07-01)

| Layer | Reuse (file) | Change |
|---|---|---|
| Profile build | `apps/axctl/src/profile/render.ts` `buildProfile` | parameterize by repo set → `TeamProfileV1` |
| Publish seam | `apps/axctl/src/profile/github-env.ts` `GitHubEnv` (Live/Test, `api(method,path,body)`) | re-point from `POST /gists` to `PUT /repos/{org}/{repo}/contents/.ax-team/{login}.json` |
| Publish flow | `apps/axctl/src/profile/publish.ts` (`createProfileGist`/`patchProfileGist`, `isStale`) | contents-API upsert (get sha → PUT) instead of gist create/PATCH |
| Consent/state | `apps/axctl/src/profile/publish-state.ts` `PublishState` (`~/.ax/profile-publish.json`) | clone → `~/.ax/team-push.json` (+ team repo, repo-scope) |
| Repo-scope | `apps/axctl/src/pwd.ts` `resolvePwdRepository`; `apps/axctl/src/dashboard/sessions-query.ts` `listSessionsHere`; `apps/axctl/src/ingest/repository-identity.ts` `chooseIdentity`/`normalizeGitRemoteUrl` (pinned, fail-closed) | new repo-scoped profile query (ProfileV1 is machine-wide today) |
| Aggregate core | `packages/community-compile/src/compile.ts` (runtime-agnostic `compileCommunity`) | swap fetcher to authed contents-API reads |
| Validation | `packages/lib/src/shared/community.ts` (manual, no-Effect; render-safe) | fork strict schema for the team profile |
| Dashboard UI | `apps/studio/src/instrument/team-metrics.tsx` (**already built**: projects/members/harnesses tabs, compare mode, teaser); `/team` route in `apps/studio/src/router.tsx` | swap `fetchMembers()` public-gist source → authed private-repo source; drop mock teaser paywall |
| CF hosting | `apps/site` TanStack Start SPA → Pages (`vite.config.ts`); `apps/community-worker` KV+webhook+cron pattern | KV holds only compiled *aggregates* (or pure client-side); **no D1** |

## 4. Security invariants (carried from spec S1, S4)

- **Repo-scoped push (S1).** Snapshot built only from the bound repo via
  `resolvePwdRepository` + repo-scoped query. Repo identity pinned fail-closed
  (normalized remote → initial commit → local path hash); forks/renames/basename
  collisions disambiguated. Whole-machine push is rejected.
- **Redaction.** No transcript content, paths, or project names - aggregates only. Scrub
  `taste.patterns[].summary` (can leak repo names / dollar amounts) in the shared
  serializer *before* redirecting the publish target. Strip `ProfileV1.github` login when
  the dev pushes anonymously.
- **No executable payloads in the telemetry repo.** `.ax-team/*.json` is data only; it is
  never activated. (The executable-mesh trust flow is a separate, already-shipped concern:
  `ax team trust`.)
- **Tenancy = GitHub ACL.** A viewer only ever reads repos they already have access to; ax
  grants nothing.

### Per-project opt-in (dev control) - first-class
A dev typically has client repos AND personal projects on one machine. Personal work must
never reach a team dashboard. The control:

- **Default-deny.** A fresh machine pushes nothing. There is no whole-machine enroll.
- **Per-repo binding.** `ax team join <org>` is run *inside* a repo and binds only that
  repo → that org. A personal repo is simply never joined, so it never pushes.
- **Binding is machine-local + private:** `~/.ax/team-bindings.json`
  (`repo_key → { org, share }`), NOT committed to the repo - it is the dev's private choice,
  invisible to teammates and absent from git history.
- **Identity pinned fail-closed** (`chooseIdentity`): a fork/rename of a personal repo
  cannot collide with a bound client repo's `repo_key`.
- **Multi-client isolation:** many repos → many orgs; each repo pushes only to its bound
  org; unbound repos push to nothing.
- **Watcher honors bindings:** post-ingest auto-push fires only for bound repos.
- **Per-field control:** `share=anon` and the sticky `no_cost` flag let a dev contribute
  adoption while withholding identity/spend. First push shows a consent screen with the
  exact repo + fields.
- `ax team status` lists what is bound and pushing; `ax team leave` unbinds and stops.

## 5. Slices (each ships independently)

### Slice 1 - repo-scoped push + per-repo binding
- `ax team join <org>` / `status` / `leave`: bind the current repo -> org in machine-local
  `~/.ax/team-bindings.json` (`repo_key -> { org, share }`). Default-deny; unbound repos never
  push. Consent screen shows the exact repo + fields at join.
- `TeamProfileV1` query: repo-scoped, redacted, daily-collapsed aggregate.
- `ax team push`: for each bound repo, builds the snapshot and upserts `.ax-team/<login>.json`
  to that org's repo through the re-pointed `GitHubEnv` seam. Refuses to push an unbound repo.
- State mirrors `profile publish` (`no_cost` sticky, `share=anon` strips login).
- Tests: default-deny (nothing pushes unbound), repo-scope isolation (fork/rename/worktree
  cannot cross bindings), multi-org isolation, redaction/scrub, anon login strip, idempotent
  upsert (contents-API sha handling).

### Slice 2 - client aggregation
- Fork `community-compile` + `shared/community` validation for `TeamProfileV1`.
- Browser fetcher over `api.github.com/.../contents` with the viewer's token; parallel
  per-dev fetch, drop failures (mirror `fetchMembers`).
- Render-safe validation guarantee preserved (hostile value renders as text, never crashes).

### Slice 3 - auth broker
- Stateless OAuth-exchange Worker (GitHub OAuth app, PKCE web flow) - **stores nothing**.
- Lock one CF origin for the SPA (first-party session; no split-origin design).
- (Alt under evaluation: GitHub App user-to-server token - see open Q1.)

### Slice 4 - dashboard
- Wire `team-metrics.tsx` to the authed private-repo source; remove mock teaser.
- Panels: adoption (active devs, team active-days/sessions trend); skill-adoption matrix
  (skill → #devs → runs → median); spend/efficiency (tokens, cost, model mix, verification
  share, tool-failure rate); workflow arcs + origin split.
- Cold-start UX: "N of M devs contributing" activation panel.

### Slice 5 - billing & paywall (per-seat, Stripe)
Pricing decided 2026-07-01: **per-seat / dev per month**.

**Billing state is NOT company telemetry** - an org→subscription record is standard SaaS
metadata, not customer IP. The zero-data guarantee (no *telemetry* at rest) holds; a
billing store leak only exposes who-pays-what, a far lower stake than the multi-tenant
telemetry DB that gated the old slices 4-7. Better Auth is still not needed - Stripe
Customer + GitHub OAuth cover identity.

**Chokepoint = the auth broker (Slice 3).** It is the one component only ax runs, and
every dashboard viewer must pass through it. Gate token issuance on entitlement:

```
viewer → GitHub OAuth → auth Worker
                          1. resolve viewer's GitHub org id
                          2. lookup entitlement[org_id]  (KV, billing-only)
                          3. active sub → mint dashboard token
                             none       → 402 → Stripe Checkout
```

**Stripe pieces (self-serve, minimal surface):**
- **Checkout** (hosted) - signup → subscription. No PCI, no card handling.
- **Customer Portal** (hosted) - upgrade/cancel/card update; zero UI to build.
- **Webhooks** - `checkout.session.completed`, `customer.subscription.updated|deleted`
  → upsert entitlement.
- **Entitlement store** - tiny KV (or D1): `github_org_id → { status, plan, seats,
  current_period_end }`. Billing metadata only; **never telemetry**.
- **Enforcement** - auth Worker reads entitlement before minting a dashboard token.

**Seat counting without a seat DB:** seats = count of distinct `.ax-team/*.json` files in
the customer repo, read **ephemerally** via the viewer/App token (never stored). Sync that
count to Stripe as the licensed subscription **quantity** (periodic reconcile job or on
push). v1 enforcement = soft (report + surface over-cap in dashboard); hard cap (deny push
/ deny token above quantity) is a fast follow.

- Tests: entitlement lookup gating (active/none/past_due), webhook idempotency, seat-count
  from repo file set, no-telemetry-in-billing-store invariant.

## 6. Encrypted-R2 fallback (documented, not built)
For teams without a git-centric flow: dev envelope-encrypts the snapshot with a team key,
uploads ciphertext to R2; the dashboard fetches + decrypts in-browser. ax stores only
unreadable blobs. Key distribution is the hard part (wrapped-key-per-member) and a
lost-key = lost-data footgun. **Design the push + dashboard-read behind a `StorageEnv`
seam** (`GitBackend` v1, `R2Backend` stub) so R2 drops in without reworking Slices 1/4.

## 7. Decisions (locked)
- Storage v1 = git-native SPA; encrypted-R2 = seam only.
- Backend stores zero company *telemetry*; GitHub repo membership = tenancy.
- Push is repo-scoped, never whole-machine.
- Pricing = **per-seat / dev per month** (Stripe); billing metadata (org→subscription) is
  the only ax-held state and is explicitly not telemetry.
- Paywall enforced at the auth broker (only ax-run component); Stripe Checkout + Portal +
  webhooks; entitlement keyed by GitHub org id.

## 8. Open questions
1. **OAuth mechanism** - plain GitHub OAuth app (PKCE + tiny exchange Worker) vs GitHub App
   user-to-server token? App gives finer repo-scoped install but more setup.
2. **Snapshot location** - `.ax-team/` dir inside the company *code* repo vs a dedicated
   `<org>/ax-team` repo? A separate repo isolates telemetry churn from code history and
   scopes access independently.
3. **Push cadence** - watcher-driven (post-ingest `--if-stale`) vs explicit `ax team push`?
   Watcher is zero-effort but noisier git history.
4. **Aggregate caching** - pure client-side (truly zero backend) vs optional KV-cached
   *anonymized aggregates* for large teams (still zero raw data)?
5. **Better Auth** - fully removed, or keep the org plugin only as a human-friendly org
   roster UI that stores no telemetry?
6. **Seat enforcement** - soft (report over-cap) vs hard cap (deny token/push above paid
   quantity) for v1? Recommend soft first.
7. **Seat definition** - pushing devs (`.ax-team/*.json` count) vs dashboard viewers?
   Pushers is cleaner to count and is the value-generating population.
8. **Entitlement store** - KV (simplest, billing-only) vs D1 (if we want invoicing/audit
   history)?

## 9. Not building v1 (deferred behind price signal)
Named per-dev breakdowns, Top Shippers / effectiveness scoring, action-card worklist,
Team Retro, the encrypted-R2 backend.
