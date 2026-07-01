# ax for teams - design-partner pitch

**Your devs are already using AI agents. You can't see whether it's working - and every
tool that promises to show you wants to hoover their transcripts into its own cloud.**

ax for teams gives you team-level adoption, skill diffusion, and spend visibility for AI
coding agents **without ever storing your data**. Your telemetry lives in your own private
git repo; the dashboard reads it in the browser. We hold zero company data.

## The problem

Teams are adopting Claude Code, Codex, Cursor, and friends fast, but leadership is flying
blind:

- **Adoption:** are devs actually using agents, or is it a few power users? Which skills
  and workflows are spreading?
- **Spend:** where is the token/subscription budget going? What's routable to cheaper
  models?
- **Effectiveness:** are agents shipping clean, or churning?

The existing answer is a SaaS that ingests everyone's transcripts into its cloud. That's a
surveillance vibe for your devs *and* a data-liability for you (their code insights,
sitting in a third party's DB).

## What makes this different - three guarantees

1. **Zero company data in our backend.** Snapshots live in *your* private git repo
   (`.ax-team/<dev>.json`). The dashboard aggregates client-side using the viewer's own
   GitHub token. Repo membership is the access boundary. If we get breached, there's
   nothing of yours to leak. (Only thing we run is a stateless login broker - it stores
   nothing.)

2. **Per-project opt-in, default-deny.** Nothing is collected until a dev explicitly binds
   a repo to the team. A dev's personal projects and other clients' repos are invisible -
   not filtered out, *never sent*. Binding is the dev's private choice; it isn't committed
   or visible to teammates. Repo identity is pinned so a fork or rename can't leak the
   wrong repo.

3. **Aggregate-first, not surveillance.** Boards are team-level (adoption trend, skill
   adoption, spend, workflows). Devs can contribute anonymously and withhold cost. This is
   coaching and ROI, not a keystroke logger - and framing it that way is what makes devs
   actually leave it on.

## What the team sees

- **Adoption:** active devs, team active-days + sessions trend, cold-start "N of M devs
  contributing."
- **Skill diffusion:** which skills/workflows spread across the team, run counts, medians.
- **Spend & efficiency:** total/median tokens + cost, model mix, verification share, tool-
  failure rate - the routable-spend lens ax already computes for individuals, team-wide.
- **Workflows:** the common skill arcs your team converges on.

## How it works (setup is minutes)

1. Create a private `ax-team` repo in your GitHub org (or a `.ax-team/` dir in an existing
   repo). Add your devs - repo membership *is* team membership.
2. Each dev, inside a client repo: `ax team join <org>`. A consent screen shows exactly
   what's shared. Personal repos are never joined.
3. Open the dashboard, log in with GitHub. It reads the repo and renders.

No agents installed on your infra. No transcripts leaving machines. Just git.

## What we're asking of design partners

We've built the local, git-native foundation. The hosted dashboard is deliberately
**gated on a real price signal** - we won't build the commercial layer speculatively. We're
looking for a small number of design partners who will:

- Tell us this is worth paying for (and roughly what) - the signal that unlocks the build.
- Pilot the per-project opt-in flow with a real team and tell us where it chafes.

## Pricing (design-partner)

Per-seat / dev per month, self-serve via Stripe, cancel anytime. Design partners get
founder pricing locked for the pilot and direct input on the roadmap.

---

_Generated with [ax](https://github.com/Necmttn/ax)._
