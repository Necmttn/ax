# ax cloud - team adoption & propagation dashboard (design)

Date: 2026-06-04
Status: validated design, pre-plan
Origin: brainstorm with Neco; pain articulated by Mitch Nick (ex-RevvedUp)

## One-line

Open-core layer on top of ax: the local OSS tool stays a private dev companion;
a hosted dashboard sells eng managers **ROI on AI spend + discovery and
propagation of siloed excellence**, fed only by aggregates the laptops compute.

## The pain (why anyone pays)

An eng manager spends real money and effort on AI tooling and is blind to the return:

- **Spend ROI** - pays ~$200/seat (Claude Max / Cursor / etc). No idea who actually
  uses it day-to-day vs. who has a dead seat. The bill is real; the usage is invisible.
- **Siloed excellence** - builds/buys internal skills and tooling, can't see how (or
  whether) engineers use them. A great workflow - e.g. one engineer's OpenTelemetry
  skill - lives on a single laptop and never spreads. The best performer's recipe
  stays trapped.

Both are the *same blindness*: the manager can't see what's happening inside his
team's agents. One telemetry engine answers both.

## Decisions locked in brainstorm

1. **Buyer = eng manager / team lead** (7–15 dev teams). Follow the money; poke the
   spend-ROI + adoption pain. Per-person *utilization* visibility is a feature here,
   not a bug.

2. **Open-core split.**
   - **ax local (OSS, free)** - the dev tool. Already built. All raw data stays local.
   - **ax cloud (hosted, paid)** - thin aggregator + manager dashboard.

3. **B's transparency buys A's permission.** A surveillance dashboard normally dies
   on distrust. Because the collector is local + open-source, a dev can read the code
   and verify exactly what leaves the machine. OSS local is the trust anchor that
   makes a paid manager dashboard survivable.

4. **Data boundary (the privacy line).**
   - Raw transcripts, prompts, code, full analytics/classification/exploration -
     **never leave the laptop.**
   - Per-person **utilization** (tokens, active days, sessions, per-harness) ships
     out - it's the seat the manager pays for, arguably already on the provider
     admin console.
   - **Behavior** (what you worked on, workflows) ships out only as **team
     aggregates** + **opt-in skill shares.** Manager learns "the team underuses X,"
     never "Bob wrote bad code Tuesday."

5. **Architecture principle: "edge computes, ship derivatives."** The laptop is both
   the privacy boundary and the compute boundary. Local ax does the heavy lifting
   (parsing, classification, weighting, workflow extraction). The cloud only receives
   small derived rows. This solves privacy *and* hosting cost in one move - no
   terabytes of transcripts to store, move, or process. Cloud stays cheap while value
   compounds.

6. **Wedge = utilization audit fronted by the gift (option C).** First paid surface
   is a spend-ROI report ("here's your AI spend, here's usage per seat, here are N
   dead seats costing $X/mo") - the cheapest aggregate to build and the fastest
   "yes." The *same* report surfaces hidden gold ("Alice built an OTel skill used
   40x, nobody else has it - share it?"). The cold number gets the manager to pay;
   the gift is what he shows the team so it doesn't read as spyware.

## Architecture

```
+- each dev laptop ---------------+
| ax local (OSS)                  |
|  - parse 5 harness transcripts  |   raw transcripts, prompts, code
|  - SurrealDB (local)            |   ----- NEVER LEAVE -----
|  - classify / weight / extract  |
|  - compute DERIVATIVES ---------+--+  small aggregate rows only
+---------------------------------+  |  (opt-in, dev-verifiable)
                                     v
                         +- ax cloud (hosted, paid) -+
                         |  thin aggregation layer    |
                         |  team rollups + dedup       |
                         |  manager dashboard          |
                         +-----------------------------+
```

### What syncs (the derivative payload) - first cut

Per dev, per sync window (e.g. daily), opt-in:

- **Utilization row** - per harness: token totals (in/out), active days, session
  count, seat = paid/dead flag. Identifiable to the dev (it's the seat).
- **Skill/tool usage rollup** - `{skill_id, invocations, role, last_used}` per dev.
  Drives the heatmap and the dedup/propagation engine. Names of skills, not contents.
- **Opt-in skill share** - when a dev publishes a local skill, its SKILL.md +
  extracted workflow recipe goes to the team library. Explicit action, never automatic.
- **Aggregate behavior signals** - failure->recovery counts, retro verdicts, hook
  effectiveness - rolled to team level, not per-person attributable.

Explicitly NOT synced: transcript text, prompts, file contents, diffs, the substance
of "what you worked on."

### How it syncs

- Opt-in at install (`ax cloud join <team>` or similar). Dev sees and can dump the
  exact payload before it sends (OSS, verifiable).
- Push from the existing local watcher / ingest cadence; derivative computed locally,
  posted to cloud. Frequency: daily batch is fine for v0 (no realtime need).
- Auth: team token. Transport: HTTPS POST of derived rows.

## Dashboard surfaces (manager-facing)

1. **Spend ROI (the paywall + wedge)** - total AI spend, usage per seat, dead-seat
   list with $ waste, trend. Fronted by hidden-gold callouts (siloed high-value
   skills) so screen #1 is "you're wasting $X *and* here's hidden gold."
2. **Tooling heatmap** - every skill/MCP/harness across the team: used vs.
   installed-but-dead; who's never touched the thing you built -> training targets.
3. **Propagation** - siloed-skill discovery (high-use-by-one / unknown-to-rest),
   one-click "recommend to team," team skill library of opt-in shares. The
   best-performer's recipe, spread. (`skills weighted` + `ax-extract-workflow`,
   team-wide.)

## Open-core / packaging line

- **Free (OSS local):** everything a single dev gets today.
- **Paid (cloud):** team aggregation, manager dashboard, propagation library,
  spend-ROI reporting. Priced per seat or per team; the $200/seat spend it audits is
  the anchor - capture a fraction of the waste it surfaces.

## Build sequencing

- **v0 (wedge):** derivative payload (utilization + skill-usage rollup) + opt-in sync
  + Spend-ROI dashboard with hidden-gold callouts. Smallest thing a manager pays for.
- **v1:** tooling heatmap + training targets.
- **v2:** full propagation engine + team skill library + recommend-to-team.

## Risks / mitigations

- **Surveillance rip-out.** -> OSS-verifiable collector; behavior is aggregate-only;
  lead with the gift, not the watch. The hard line: per-person *utilization* yes,
  per-person *behavior* never.
- **Manager wants more than the line allows** ("let me see what Bob built"). -> hold
  the line; that demand is exactly what turns the tool toxic and gets it removed.
- **Dev opt-in rate too low to be useful.** -> utilization can be argued as
  already-visible on provider admin consoles; the dev-facing value (local analytics,
  getting credited when your skill spreads) is the carrot for opting in.
- **Provider token data granularity** - confirm ax's local token-per-turn parse is
  accurate enough to drive a spend report (memory notes tokens are the real
  cross-provider signal; Codex turn rows inflate ~10x, must filter role).

## Open questions

1. Pricing model - per-seat vs. per-team vs. % of audited spend?
2. Sync identity - how is a dev tied to a team + to their paid seat (SSO? email
   domain? manual invite)?
3. Does v0 need realtime, or is daily batch genuinely fine? (assume batch)
4. Is "opt-in per dev" enough, or does the manager need an org-mandated mode - and
   does mandating break the trust model that makes it work?
5. Token/spend accuracy: can local parse alone produce a defensible $ number, or does
   v0 need to read the provider billing/admin API for ground truth?
