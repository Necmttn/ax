# ax cloud - team layer (design, post-grill)

Date: 2026-06-04 (grilled 2026-06-05)
Status: validated design, pre-plan
Origin: brainstorm with Neco; pain articulated by Mitch Nick (ex-RevvedUp);
sharpened by a /grill-me pass (13 forks) + competitive signal (Everlier LLM
gateway, Pocock/TanStack Intent skill distribution).

## The beam (decision #1 - everything hangs on this)

**ax is never the substrate. ax is the meaning layer over whatever substrate the
team already has.** Collection (transcripts | LLM gateway), distribution
(npm | git), and history (git | jj) are commodities ax *reads from and
annotates* - never things ax *becomes.* This single principle resolved three
separate "should we build X?" forks identically (gateway, npm, VCS): building the
substrate is always a different, crowded, ops-heavy company that destroys ax's
only moat. The moat is **meaning**: what's used, why it changed, whether it
worked, what should spread.

## The pain (why anyone pays)

A team spends real money + effort on AI tooling and is blind to the return:

- **Spend / sprawl** - pays ~$200/seat across many tools; engineers swap
  models/providers/harnesses weekly. Each provider console is a silo; nobody sees
  *across* them, deduped, per person. Dead seats and duplicate seats are invisible.
- **Siloed excellence** - a great workflow (one engineer's OTel skill) lives on one
  laptop and never spreads. The best performer's recipe stays trapped.

Same blindness, one engine. Provider consoles structurally **can't** close it
(they won't show competitor spend, and they only meter tokens, never *outcome*).

## Two positionings, one engine (don't pick the buyer in a doc - pick it in the market)

Qualify buyers on **AI-spend + a named owner of that spend**, not headcount
(AI-native teams are small but spend heavily). Run both as landing pages / pitches;
whichever lands/pays first sets the headline.

- **Positioning A - eng-manager / spend + adoption** (`/teams`):
  "See what your team's AI spend is actually buying - every seat, every harness,
  without reading anyone's code."
- **Positioning B - applied-AI team / governed skill sync** (`/registry`):
  "Ship curated skills to your whole team; their agents send fixes back."
  ICP: applied-AI teams arming **non-engineer domain experts** (legal, finance,
  consulting). Acute, present pain - they're hand-rolling repo locks today.

## The wedge: governed skill sync + suggestion loop (was: spend dashboard)

The grill flipped the wedge. "Adoption analytics" is a vitamin; "my domain experts
keep polluting the skill repo and I can't cleanly ship them curated, current
skills" is a painkiller someone feels *now*.

```
author/edit skill → govern (review gate) → sync down to laptops
   ↑                                                   ↓
recommend promote/deprecate ←── ax ranks by usage ──── consumer agent uses it
   (intelligence layer)            evidence                → hits edge case
                                                           → emits suggestion up
```

- **Governance = suggestion/review loop, not RBAC walls.** Consumers aren't locked
  out; their *agent* proposes changes upstream; authors accept/reject; updated skill
  re-syncs. Clean repo preserved by the gate, made smart by ax ranking. This is
  ax's existing `improve recommend/accept/lint` machinery pointed at a multiplayer
  registry.
- **Source of truth:** managed skills sync **read-only** locally (the registry
  already distinguishes `writable` sources). A local edit becomes a ranked
  suggestion (≈ a PR via the VCS's own gate) or a clearly-labeled local override -
  never an in-place clobber, never silent drift. Personal/unmanaged skills stay
  fully writable.
- **Skill-edit = first-class intent event.** ax already dual-writes agent events; an
  `Edit`-skill tool call + surrounding reasoning + post-change outcome = *why this
  changed and did it work* - queryable. git/jj/npm/gateway structurally cannot do
  this.

Spend/adoption analytics demotes to **v1** and rides the same engine as the
*evidence layer* that makes the registry smart (promote/deprecate, "what's working").

## Privacy: the suggestion channel can't leak what the privacy line protects

The specificity that makes a suggestion useful ("failed on M&A indemnity clauses")
is the sensitive context - attorney-client privileged for the legal ICP. So:

- **Upstream carries failure-shape, not content.** `{skill_id, failure_mode, step,
  frequency}` - never the payload that triggered it.
- **The local agent is the redaction proxy** ("become the proxy"): on failure it
  synthesizes a **runnable, PII-stripped synthetic repro test** that reproduces the
  failure deterministically. Upstream gets a *failing regression test*, never the
  real matter. Author fixes skill → test goes green → re-syncs. The registry accrues
  a regression suite born from real failures, zero privileged content.
- **Two-tier redaction (per-registry policy flag):**
  - *Light (default)* - best-effort redact + auto-share. Frictionless, non-regulated.
  - *Regulated* - adversarial recover-pass (a second local pass tries to recover any
    real identifier; fail → never leaves) + local consent gate (author/consumer sees
    the exact artifact, OSS-verifiable) + provenance stamp (redaction method +
    reviewer, auditable/revocable).

## Architecture: edge computes, ship derivatives

The laptop is both the privacy boundary and the compute boundary. Raw transcripts,
prompts, code - never leave. ax local computes small **derived rows**; the cloud is
a thin aggregator + registry + dashboard. Solves privacy *and* hosting cost at once
(no terabytes of transcripts to store/move).

```
+- each dev laptop --------------+
| ax local (OSS)                 |  raw transcripts/prompts/code = NEVER LEAVE
|  - parse 5 harnesses           |
|  - classify / weight / extract |
|  - compute DERIVATIVES --------+--+  small opt-in, dev-verifiable rows
|  - MCP control plane (sync ops)|  |
+--------------------------------+  v
                        +- ax cloud (thin) -+
                        | aggregates + team  |
                        | skill registry     |
                        | dashboard          |
                        +--------------------+
   (collection / distribution / history substrates are pluggable + external)
```

### Feasibility (what exists vs net-new)

- **Exists (laptop hooks are friendly):** `IngestStreamBus` seam built to swap the
  local backing for a hosted backend (`dashboard/ingest-stream.ts:9-11`);
  session-share publish primitive (`share/gist.ts`); pluggable skill sources with a
  `writable` flag (`skills/sources/registry.ts`); `ax mcp` (read-only, 10 tools).
- **Net-new (the bulk of v0):** cloud service + team/member/registry data model
  (DB is single local SurrealDB today) + identity + bidirectional sync/reconcile.

### MCP - two meanings, don't conflate

- **Control plane (v0):** ax's *own* MCP gains sync/registry ops, so an agent
  self-serves in-session ("sync my skills", "what changed", "submit upstream").
  Crosses ax's deliberate read-only line → the **author-vs-consumer permission
  boundary must be enforced at the MCP tool scope** (a consumer agent may
  `submit-suggestion`, must NOT `accept-merge`).
- **Payload (deferred):** distributing *third-party* MCP servers to laptops =
  RCE-grade blast radius + secrets. If ever: manifest-not-secrets (reference the
  team's vault, never store), signed/provenanced even in light mode. **Not v0.**

## Pricing: cheap for reach, margin in the premium tier

Monetization must not fight propagation. Unit = **consumer seat** (the domain
expert *receiving* curated skills), not author seat - consumers are many and
expensive professionals; charge a sliver of one billable hour/seat/month so the
buyer never rations the rollout. Margin lives in the **premium org tier**: regulated
mode (adversarial redaction, consent gate, provenance), the intelligence layer
(usage rankings, promote/deprecate), SSO/admin. Avoid per-run/per-suggestion
metering at v0 (punishes usage = anti-propagation).

## Open-core line

- **Free (OSS local):** everything a single dev gets today.
- **Paid (cloud):** team registry + governed sync, suggestion-loop + ranking,
  premium org tier (compliance + intelligence + admin). Analytics/spend dashboard = v1.

## Build sequencing

- **v0:** team/registry data model + identity + bidirectional sync; managed
  read-only skill sync; suggestion loop (failure-shape + synthetic repro test, light
  redaction); ax-MCP control plane with role-scoped tools; usage ranking of
  suggestions. **Skills only - no MCP payload.**
- **v1:** spend/adoption analytics dashboard (cross-harness unified, dedup, dead/dup
  seats, outcome linkage); regulated redaction mode; MCP-manifest sync (signed).
- **v2:** promote/deprecate automation; vertical expansion (legal → finance/consult).

## Risks / mitigations

- **Substrate temptation** (be the gateway/npm/VCS) → the beam: overlay, never become.
- **Coverage hole** - ax is a passive observer; a dev can run agents outside ax. v0
  accepts passive-coverage-with-honest-labeling; the dev-facing value (local
  analytics, getting credited when a skill spreads) is the carrot for staying installed.
- **Laundered leak** - agent "redacted" test still carries a real identifier, now
  labeled safe → travels further. Mitigated by regulated mode (adversarial + gate +
  provenance); light mode is best-effort and explicitly scoped to non-regulated.
- **Governance bypass** - a consumer agent merging via MCP. Enforce author/consumer
  scope at the MCP tool layer, not just UI.

## Open questions

1. Identity/sync - how a dev binds to a team + seat (SSO / email domain / invite)?
2. Batch vs realtime sync for v0 (assume near-real-time pull on session start +
   daily push).
3. Opt-in vs org-mandated coverage - mandate only the utilization half (already the
   employer's, like the AWS bill); behavior stays opt-in + aggregate. Does mandating
   even utilization dent trust enough to matter?
4. Private team registry vs the parked public community registry/mesh - do they
   connect, and when?
