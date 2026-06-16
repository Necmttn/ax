# Fix #1b - Hosted Team Backend (v2, post-review)

**Date:** 2026-06-15 (revised 2026-06-16 after a 3-way design review: 2 opus + independent Codex)
**Branch:** `feat/team-backend-spec`
**Parent diagnosis:** `docs/superpowers/specs/2026-06-15-team-adoption-diagnosis.md`
**Builds on:** `2026-06-15-usage-telemetry-design.md` (Fix #1a - `ax_invocation` + `ax usage --json`, merged)

> **Revision note (v2.1).** Two review rounds. **Round 1** (architecture/security, product/scope, independent Codex) → re-scope, re-sequence, fix 4 security criticals. **Round 2** (same three re-verified v2) → 2 reviewers "Ship", Codex "fix-before-build" on 3 sharp items, all now folded into this v2.1. Key changes from v1: (1) **lead with `ax team sync`** (individual-dev pull) - now as **Slice 0, local/no-backend**, to validate the wedge before plumbing; (2) **repo-scope the push** with a **pinned repo-identity model** (normalized remote + provider id, fail-closed); (3) first-class **security model** (org-bound token w/ full lifecycle, `requireOrgMember` tenancy guard, hook-trust, trust-on-change for ALL `.ax/` artifacts); (4) **honest "pseudonymous" framing + k-anonymity** small-cohort suppression (not "truly anonymous"); (5) **defer** the analytics surface behind a design-partner **price signal**; (6) **split the executable-hook mesh** into its own security-gated spec; (7) cold-start/maturing dashboard state made load-bearing.

## Problem

ax is single-player. A team adopting AI-agent development has no shared surface: a dev who builds a better way of working can't spread it; a lead can't see whether the team is adopting agent practices or how spend/efficiency trend. The commercial blocker (diagnosis Finding 4) is the missing team surface. But the diagnosis's deeper lesson (Finding 3) is that **pull-based, individual mechanisms with no individual payoff die in adoption** - so the team product must give the *individual dev* a reason to opt in, not just give the manager a dashboard.

## What the review changed (and why)

A manager-push *measurement* product re-creates the exact death-valley: devs have zero reason to `ax team join`, and the headline per-dev value (Top Shippers, coaching) is gutted by **adverse selection** - strugglers opt anonymous, so the people a lead most needs to see disappear; pressuring them to go named *is* surveillance. So v1 leads with the inverse:
- **Individual-pull first:** `ax team sync` - run it, instantly get the team's working tooling. Positive payoff to the dev; also what makes the dashboard non-empty.
- **Anonymity-robust aggregate** dashboard - fully valuable with 100% anonymous devs.
- **Per-dev/Top-Shippers/action-cards/retro deferred** behind a real price signal (they're large net-new analytics, noisy on small-N, and carry surveillance optics).

## Scope (revised v1)

**v1 (thin, build first):**
- **Org-bound, repo-scoped push** of a team-scoped profile + usage. Better Auth (org + device plugins) on CF Pages Functions + D1. Self-serve org create + invite.
- **`ax team sync`** - activate the team's **non-executable** rig (skills-as-prompts, rules, agent definitions) from a plain `.ax/` repo folder into the runtime. Executable hooks are gated (see Security).
- **Anonymity-robust aggregate dashboard** (studio `/team`): active devs, skill-adoption matrix, spend + model-mix, common workflow arcs, unused surface. No names required.

**Deferred behind a design-partner price signal (v2 analytics):** named per-dev breakdowns (opt-in), Top Shippers / effectiveness scoring, the action-card worklist, Team Retro, the percentile engine. These are real and valuable - but they're a large build, they're degraded by the consent model, and we should not bet the build on "teams will act on a derived worklist" before a team has paid for the aggregate.

**Split into its own spec (executable mesh + trust):** `.ax.local/` experiment overlay, telemetry-gated promotion, and **activation of executable hooks/agents** - because auto-activating committed executables is an RCE channel that needs a trust design (below). v1 sync handles non-executable artifacts only.

## Security model (first-class - the four criticals)

### S1. Data boundary: repo-scoped, not whole-machine (Critical)
`ProfileV1`/usage aggregate the dev's *entire machine* - personal projects, side work, **prior/other-employer repos**. Pushing that to a team backend leaks it to the manager and pollutes team metrics. **v1 pushes a team-scoped profile only:**
- The dev binds the team to specific repo(s) at join. The push builds a `TeamProfileV1` from **only those repos**. NOTE (net-new work, not a free redirect): ax has repo-scoped *ingest/queries* (`ingest here`, `sessions here`), but the **profile aggregation** (`apps/axctl/src/profile/queries.ts`) is currently machine-wide; producing a repo-scoped `TeamProfileV1` is real query work in Slice 2.
- **Repo-identity model (PINNED - this is the security-boundary key, resolving prior Open Q1):** a repo is identified by its **normalized remote URL + provider repo id** (reuse ax's existing `repository`/`checkout` normalized-remote identities), NOT the basename (basename collisions, renamed remotes, and forks would mis-scope). Worktrees map to their repo. The backend stores the org's `team_scope` as these normalized ids and **fails closed**: a payload whose `repo_key` isn't a registered scope → 401; an unmatched/ambiguous local repo is excluded, never guessed. Tests cover fork, renamed-remote, worktree, duplicate-basename.
- **Honesty caveat:** the repo boundary lives in the consent screen + the client's scoped queries; the backend can verify the *claimed* `repo_key` is in `team_scope` but cannot prove the data *came from* that repo. Threat model = "don't accidentally leak other repos," not "defend a malicious authed dev exfiltrating their own data."
- `ProfileV1.github` (the login) is **stripped client-side when `share=anon`**; anon rows store `login = NULL`. **Honest framing (per review): v1 sharing is PSEUDONYMOUS, not cryptographically anonymous** - `dev_snapshot` retains `user_id` (required for upsert dedup + `ax team leave` right-to-delete), so an operator/admin-bug could re-link to the Better Auth member. We say "pseudonymous / not displayed," never "truly anonymous." **Small-cohort protection:** aggregate panels apply **k-anonymity suppression** - any cell backed by `< k` devs (k=5, or the whole team if smaller, with a "needs N more contributors" state) is suppressed/rounded so a 2-3-dev team's "aggregate" can't trivially reveal an individual.
- `taste.patterns[].summary` is raw `ax improve` hypothesis prose that can carry repo names / dollar amounts (the publish-gate scrub was deferred in the gist path). **Implement that scrub in the shared serializer** before redirecting the publish target, so both the gist and team paths benefit. Until then, omit `taste.summary` from the team payload.

### S2. Tenancy isolation: explicit guard on every endpoint (Critical)
Better Auth's org plugin enforces membership only on *its own* routes - **not** our `/api/team/push` or `/api/team/overview`. One missing scope leaks all tenants' rows from the single D1 DB.
- One `requireOrgMember(ctx, role)` middleware returns `{ userId, orgId, role }`; **every** custom handler routes through it before any query. Raw D1 access is banned outside org-scoped helpers.
- `org_id` is **always** from the authed context, never the request body. Every `dev_snapshot` query carries `WHERE org_id = ?`.
- **Mandatory test:** org A's session/token against org B's `org_id` returns 403 - not merely "the SQL filtered." Plus removed-member and anonymous-row cases.

### S3. Org-bound device token (Critical)
Better Auth's device flow issues a *user* token; "active organization" is mutable session state. A multi-org user could push to the wrong org. **Mint an ax-owned token record at approval:** `team_device_token { token_hash, user_id, org_id, team_scope, share, scopes:[push,status], device_label, created_at, expires_at, last_used_at, rotated_from, revoked_at }`. Push resolves org from **that record**, never the live session. Token stored in the OS keychain (fallback `~/.ax/team.json`), ax-scoped (push/status/leave only) - never a full Better Auth session token on disk. **Lifecycle (per review):** tokens **expire** (`expires_at`, re-join to refresh), support **rotation** (`rotated_from`), stamp `last_used_at`, are **rate-limited** at push, and are **revoked automatically when the member is removed from the org** (test this). `ax team leave` revokes it.

### S4. Hook-trust: no auto-activation of committed executables (Critical → own spec)
`ax team sync` auto-activating `.ax/` **executable hooks** on `git pull` is arbitrary code execution on every teammate's machine (a merged PR or one compromised push = RCE). ax has **no trust gate today** (install writes `bun <file>`, fail-open). Therefore:
- **v1 sync activates non-executable artifacts only** - meaning **not directly `bun`-executed** (skills-as-markdown/prompts, rules, agent definitions). NOTE (per review): "non-executable" ≠ "harmless" - a committed prompt/rule is a **prompt-injection / behavior-steering surface** (it can nudge an agent toward exfiltration or toward disabling verification), and a skill can bundle scripts the agent later invokes. It's strictly lower-risk than an auto-firing `bun` hook (mediated by the agent + the user's existing Bash approval), but **v1 still applies trust-on-change + a diff prompt to ALL `.ax/` artifacts** and activates only from the repo's trusted/default branch, never an arbitrary checkout.
- **Executable hooks/agents are gated** behind a trust layer designed in the separate mesh spec: content-hash pinning per artifact in a per-machine trust file; **trust-on-change** (interactive `ax team sync` approval showing a diff since the last trusted hash); never auto-on-pull; optional signing against an org member key. This is a security spec, not a fast-follow bullet.

## Stack + required spikes

**Cloudflare** Pages Functions + **D1**, **Better Auth** (organization + device-authorization plugins) via the **Drizzle adapter**, in the existing `apps/site` CF Pages project. Two spikes are slice-1 preconditions (the review flagged both as real, not theoretical):
- **D1 migrations in the deploy pipeline.** `better-auth` schema generate → Drizzle Kit → committed SQL → `wrangler d1 migrations apply` is a **separate CI step** the Pages deploy does not run. Prove the full loop on a throwaway table before building on it.
- **One origin, locked (not a "lean").** The hosted studio SPA + the team API **must share one origin** (`ax.necmttn.com`, one Pages project) so Better Auth session cookies are first-party. A split (separate Worker/subdomain) means `SameSite=None` + CORS-credentials + CSRF - a separate security design. **Decision: one project, same origin.** A split is out of scope.

## Data model

```sql
-- Better Auth owns: user, session, account, organization, member, invitation,
-- device-code, etc. (its own Drizzle/D1 migrations). We own only:
team_scope        (org_id, repo_key, added_by, created_at)        -- normalized-remote repo ids (S1)
team_device_token (token_hash, user_id, org_id, team_scope, share, scopes,
                   device_label, created_at, expires_at, last_used_at, rotated_from, revoked_at)  -- S3
dev_snapshot      (org_id, user_id, login NULL-when-anon, repo_key,
                   summary_cols..., profile_json, usage_json, pushed_at,
                   PRIMARY KEY (org_id, user_id, repo_key))        -- repo-scoped, S1 (user_id = pseudonymous key)
dev_snapshot_history (org_id, user_id, repo_key, day, summary_cols...,
                   PRIMARY KEY (org_id, user_id, repo_key, day))   -- DAILY-collapsed, bounded count
```
Notes from review: D1 has a ~2MB/row string cap and single-threaded DBs - store **normalized summary columns** (active_days, sessions, tokens, cost, model_mix, distinct_skills, …) for the aggregate queries, keep the raw blob only for drill-down, and index `(org_id, pushed_at)`. **`dev_snapshot_history` is collapsed to one row per (dev, repo, UTC day)** (PK enforces it) - the watcher pushes many times/day but history upserts the day's row, so trend storage is bounded (not unbounded append). Retention: keep `90d` of daily history (configurable); hard-delete on `ax team leave`.

## v1 dashboard (anonymity-robust aggregate)

Studio `/team` route, hosted, Better Auth session, admin-role gated. **Every panel is valuable with 100% anonymous devs**, and every cell respects k-anonymity suppression (S1):
- **Adoption:** active devs / members; team active-days + sessions trend (summed daily series).
- **Skill-adoption matrix:** skill → # devs using → total runs → median - team-wide vs solo; the aggregated **unused surface**.
- **Spend + efficiency:** total/median tokens + cost, **model mix** (frontier vs cheap), verification share, tool-failure rate.
- **Workflow:** team-common arcs (aggregate), origin split.

Reframed: surface the **practice, not the person**, never a leaderboard of humans. **Copy honesty (per review):** claim only what the current aggregate fields support - "the `plan→tdd→verify` workflow is used by 4/6 devs" or "correlates with a lower tool-failure rate," NOT "ships clean" (outcome-weighting is the deferred v2 `workflow_evidence`). No `est_impact $` extrapolations in v1 (noisy/unvalidated).

**Cold-start / data-maturing state (N2 - now the biggest remaining product risk).** Aggregate-only means the board is empty/noisy until several devs have synced + joined + pushed + ~2 weeks accrue, while the only adoption driver (`ax team sync`) is per-dev. So the empty/maturing UX is load-bearing, not an afterthought: (a) an explicit "N of M devs contributing - invite the rest" activation panel with the join flow front-and-center; (b) per-panel "needs `k` more contributors to show this" states (ties to k-anonymity); (c) a seeded **demo org** the admin can preview so the first open is never a blank page. Visual scope: functional-but-clear; taste pass later.

## `ax team sync` (the individual-pull feature)

`ax team sync` reads the committed `.ax/` folder and activates its **non-executable** rig into the runtime (`~/.claude/skills`, agent defs, rules; Codex equiv) - so a dev who runs it instantly works the way the team works. Auto-offered on entering the repo (a prompt, not silent execution). Harness-native project folders (`.claude/`, `.agents/`) already auto-load; ax bridges the rest. **Executable hooks are listed but require the trust-gated approval (S4), never auto-activated.** This is the feature with positive individual payoff - it drives `ax team join`, which fills the dashboard.

## Privacy & consent

ax's default is "nothing leaves the machine"; #1b is the explicit, opt-in, **repo-scoped** exception:
- Nothing leaves until `ax team join` + browser approval; the approval shows exactly which **repos** and what fields.
- v1 is **aggregate + anonymous** (no per-dev names; `login = NULL`). Named per-dev is a deferred, explicitly-opt-in v2 layer - never default, never required for core value.
- Only the team-scoped, redacted profile + usage leave: no transcripts, code, file contents, flag values, positional args; `taste.summary` scrubbed/omitted.
- **Right-to-delete semantics (defined):** `ax team leave` deletes `dev_snapshot` + history rows, revokes the token, and is reflected in aggregates on next recompute. Document D1 time-travel/backup retention + a hard-delete path for a paying customer's DPA.

## Positioning (reframed)

Drop "software factory" and "Top Shippers" as external framing (line-worker / leaderboard optics; internal names leak to UI). Use **DORA/SPACE as analogy, not product name** - v1 ships 0/4 DORA keys and SPACE-Satisfaction only as a proxy; leading with those invites a buyer to demand metrics we can't ship. Honest positioning: **"the missing visibility + tooling-sharing layer for how your team works with AI agents."** The two tracks have two buyers - keep them as distinct narratives (the mesh may be the more defensible wedge: telemetry-gated promotion of agent config into a git rig has no incumbent; a measurement dashboard is imitable once agent-OTEL is standard).

## Build order (RE-SEQUENCED 2026-06-16, post-dogfood)

Slice 0 shipped (PR #440). **Dogfooding it on the ax repo revealed the pull is in the GATED/experimental layers, not non-executable sync alone (see Dogfood findings below).** So the **mesh moves AHEAD of the hosted backend** - it's git-native/local (no hosted infra), it's where the individual-dev pull lives, and it generates the very telemetry the later dashboard needs.

0. **✅ Slice 0 - LOCAL `ax team sync`** (merged #440). Non-executable rig (`.ax/skills`, `.ax/agents`) → runtime, trust-on-change, fail-safe, hooks gated.
1. **Mesh A - executable-hook trust layer.** What makes sync compelling: activate the team's executable hooks/agents with a real trust gate - **cryptographic** (sha256, NOT `Bun.hash`) content-pin per artifact in a per-machine trust file, **trust-on-change** interactive diff, activate only from the trusted/default branch, never auto-on-pull. Local; no backend. (This was "own security spec" - promoted to next because it's the pull.)
2. **Mesh B - `.ax.local/` experiment overlay + local promote.** `ax team experiment start <name>` → gitignored overlay layered over committed `.ax/`; iterate isolated; `ax team experiment score` (reuse local telemetry/spar); `ax team experiment promote` → moves overlay→`.ax/` + opens a PR. Still local/git-native - the promote evidence is LOCAL telemetry first; hosted cross-dev aggregation comes with the backend.
3. **Auto-sync-on-enter + cross-harness.** Offer `ax team sync` on entering a repo with an `.ax/` rig (a prompt, not silent); project the rig into Codex too (Slice 0 is Claude-only). Addresses the cwd-bound friction the dogfood hit.

**THEN (gated on a design-partner price signal):**
4. **Backend + push foundation** - Better Auth (Drizzle/D1, org + device, self-serve org create) + the **migrations spike** + **one-origin lock** + `team_scope` (normalized-remote ids) + `requireOrgMember` guard + org-bound `team_device_token` (full lifecycle) + `POST /api/team/push` (repo-scoped, schema-validated) + `dev_snapshot`(+daily history) + **tenancy/scope/anon/k-anon tests**.
5. **`ax team join/status/leave` + repo-scoped push** - device flow + repo-scope consent + keychain token + watcher push + net-new repo-scoped `TeamProfileV1` query.
6. **Aggregate dashboard** - studio `/team` + `/api/team/overview` (aggregate-only, k-anon) + cold-start/demo-org state + create-team/invite UI.
7. **v2 analytics** (also price-gated): named per-dev, action-card worklist, Team Retro, percentile engine, `workflow_evidence`.

## Dogfood findings (2026-06-16, `ax team sync` on the ax repo)

Mechanically flawless (fail-safe, activation, hook-gating, idempotency all verified on real content; the synced skill loaded live in the harness). Key learnings folded above:
- **Non-executable sync alone = modest pull.** Over committing skills to `.claude/skills/` (which the harness already auto-loads), Slice 0's marginal value is the trust gate + the unified namespace. The *compelling* pull is the **executable hooks** (gated) + the **experiment/promote loop** → hence the re-sequence (mesh before backend).
- **`.ax/` is gitignored** in ax (local scratch: tasks/experiments/dojo). The committed team rig needs a carve-out: `.gitignore` `.ax/*` (not wholesale `.ax/`) + `!.ax/skills/` `!.ax/agents/` so the rig is versioned while scratch stays ignored (git can't re-include under a wholesale-excluded dir). The spec's "plain tracked `.ax/` folder" decision **depends on this carve-out** (or a non-ignored folder). Seeded in PR #451.
- **cwd-bound:** sync reads `.ax/` from the repo at PWD - run it from the wrong repo → "no rig found." The auto-sync-on-enter (build step 3) is the real fix.
- **Graph lag:** a freshly-synced skill isn't in `ax skills search` until the next ingest (harness loads it immediately; ax's own graph lags). Minor/expected.
- **Hash:** `Bun.hash` is fine for Slice 0 change-detection but the **executable**-hook trust (step 1) MUST use sha256 (collision = security boundary there, not just change-detection).

## Commercial gates (pre-revenue, named explicitly)

- **Price signal before the backend + analytics build (steps 4-7):** secure 2-3 design-partner teams with a verbal/written price; gate the hosted build on it, not the reverse. The mesh (steps 1-3) ships ahead - it's local, it's the pull, and it earns the partner relationship.
- **Infra trust before external pilots:** a commercial domain + an isolated CF project/account (not `necmttn`'s personal account) before any team with a security review; add an org-level "aggregate-only / named-sharing-disabled" mode + a data-export endpoint to the commercial roadmap.

## Commercial gates (pre-revenue, named explicitly)

- **Price signal before the analytics build:** secure 2-3 design-partner teams with a verbal/written price; gate the v2 analytics on it, not the reverse.
- **Infra trust before external pilots:** a commercial domain + an isolated CF project/account (not `necmttn`'s personal account) before any team with a security review; add an org-level "aggregate-only / named-sharing-disabled" mode + a data-export endpoint to the commercial roadmap.

## Open questions

1. **Multi-repo team UX** - `team_scope` binds a team to repos (identity model PINNED in S1: normalized remote + provider id). The remaining question is the *UX* of a dev who works across N team repos / monorepo+satellites - how binding/consent is managed across multiple repos. Resolve at Slice 2 consent design.
2. **Onboarding at scale** - a 20-dev team = 20 device-flows with low individual payoff *unless* `ax team sync` lands the value. Slice 0 validates exactly this before the backend is built; carry an admin "invite + one-line setup" path into Slice 2.

## Status

**LOCAL / git-native (the pull - build next, no hosted infra):**
- [x] Slice 0: `ax team sync` LOCAL non-executable rig activation + trust-on-change (MERGED #440); team rig seeded #451
- [ ] Mesh A: executable-hook trust layer (sha256 content-pin, trust-on-change diff, trusted-branch-only) - the compelling pull, per dogfood
- [ ] Mesh B: `.ax.local/` experiment overlay + `ax team experiment start/score/promote` (local telemetry; promote→PR to `.ax/`)
- [ ] Auto-sync-on-enter + cross-harness (Codex) activation

**HOSTED (gated on a design-partner price signal):**
- [ ] Backend + push foundation (Better Auth Drizzle/D1, migrations spike, one-origin lock, team_scope, requireOrgMember guard, org-bound token, repo-scoped push, dev_snapshot+daily-history, tenancy/scope/anon/k-anon tests)
- [ ] `ax team join/status/leave` + repo-scoped push (device flow, consent, keychain token, net-new TeamProfileV1 query)
- [ ] Aggregate dashboard (studio `/team` + `/api/team/overview` aggregate-only + k-anon + cold-start/demo-org + create-team/invite)
- [ ] v2 analytics: named per-dev (opt-in) + action-card worklist + Team Retro + percentile engine + `workflow_evidence`
