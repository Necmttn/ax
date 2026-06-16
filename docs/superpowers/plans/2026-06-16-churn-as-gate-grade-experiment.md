# Experiment: can churn-delta be gate-grade? (the SkillOpt crux)

**Date:** 2026-06-16
**Origin:** SkillOpt paper review (arxiv 2605.23904). A 4-angle panel (codex + 3 subagents)
split on one question that decides ax's north-star.

## The fork

SkillOpt's whole method rests on an auto-grader: `r(s) ∈ [0,1]`, same task re-run under
different skills, everything else held fixed. The paper flags open-ended work (writing,
design, real coding) as the *unsolved* case - no cheap grader exists.

ax claims to mine that grader from real sessions (churn / repair-LOC / episodes). Two
readings, both defensible, mutually exclusive:

- **Strategy angle:** churn IS a usable grade - ax = the open-ended verifier, a credible
  north-star *if* attribution + held-out discipline ship.
- **Skeptic angle:** churn is a confounded proxy with sign ambiguity (low churn = skill
  worked OR task trivial OR agent gave up). It can *never* be clean; the paper named this
  exact failure. ax has the same problem with the warning label peeled off.

Don't bet the roadmap on a guess. **Measure whether the proxy separates known-good from
known-bad skill edits.** Cheap to run, decisive.

## Hypothesis

H1: For a skill edit (a `skill_revision`), the change in downstream verification churn
(before-revision sessions vs after-revision sessions, same skill) carries signal:
good edits ↓ repair-LOC / episode-rate, bad edits ↑.

H0: churn-delta is indistinguishable from noise once you can't hold the task fixed.

## Method (retrospective, no new re-runs - uses existing graph)

1. **Edit events.** Pull `skill_revision` rows (already store change ts + byte delta).
   Keep skills with a revision that has ≥ N invoking sessions both before and after
   (N≈8 to start; widen window if sparse).
2. **Outcome per side.** For the before-window and after-window sessions that `invoked`
   the skill, compute mean repair-LOC and episode-open-rate via the existing
   `metrics/session-churn.ts` machinery. `churn_delta = after − before`.
3. **Ground-truth label for each edit** (the hard part - proxy for "was this a good edit"):
   - **bad** = the revision was reverted, OR followed by another revision of the same
     skill within a short window (churn-on-the-skill-itself = the author wasn't happy).
   - **good** = the revision was stable (no follow-up edit) AND the skill kept being
     invoked (retention up or flat).
   - This label is itself imperfect - state it as a limitation, not ground truth.
4. **Test.** Does `churn_delta` separate good-labeled from bad-labeled edits?
   Sign test / permutation across the ≥K qualifying skills. Report effect size against a
   noise floor built by shuffling the good/bad labels.

## Confound controls (the whole point)

- Same skill holds skill identity fixed, but **task mix differs across the two windows** -
  that is exactly the confound the skeptic names. Mitigations:
  - bucket sessions by repo / task-family before differencing; difference within bucket.
  - require minimum sample per bucket; drop thin buckets (log what's dropped - no silent caps).
  - report the permutation noise floor *prominently*; a positive result that doesn't clear
    it is a null result.

## Decision rule

- **churn_delta separates good/bad at effect size > noise floor, p<0.05, across ≥K skills**
  → the cheap observational proxy is gate-worthy. ax = verifier is real; build
  `ax verify <skill@version>` on top of it.
- **No separation** → confounds dominate; ax cannot grade open-ended edits from passive
  telemetry. Earning "verifier" requires *controlled re-runs* (a spar SET with a
  skill-under-test) - expensive, and the dojo's spar is the only honest path. Down-rank
  the "ax is ahead on the verifier" claim accordingly.

## Cost

One query + one stats pass over the existing graph. No agent re-runs, no quota burn.
Run before committing any roadmap to the verifier north-star.

## Run 1 result (2026-06-16): blocked upstream, crux still untested

Ran the volume probe (`scripts/prototypes/churn-gate-probe.ts`) against the live graph.
**Data-starved - experiment cannot run yet.** Findings:

- Only **17 `change='changed'` skill_revision events on 8 skills** - and 8 is inflated by
  the `necmttn:` plugin-namespace dupe; ~4 real skills (`zoom-out`, `plannotator-*`).
- **0 of 17 edits had ≥5 invoking sessions on both sides** of the edit ts. The single edit
  with any data (`plannotator-annotate`: 9 before / 1 after) still fails. Most edited skills
  show `total=0` invocations.

Root cause is NOT confounding (we never reached the stats) - the join is structurally empty:

1. **`skill_revision` is sparse + recent.** The revision-tracking feature shipped recently
   and history was never backfilled ("pre-existing sessions read zero until re-ingested").
   17 events, all on rarely-edited utility skills, none on the workhorses.
2. **Edited skills had near-zero invocations in the window.** The namespace dupe also split
   what little signal existed (now fixed in the dedupe commit). Few edits land on busy skills.

**Verdict:** the strategy-vs-skeptic crux is **still unresolved** - neither side confirmed.
But the blocker moved from "is the proxy gate-grade?" to **"ax can't yet observe edit->outcome
at all."**

### Why, precisely (after reading the ingest)

The dominant blocker is **`skill_revision` sparsity**, NOT activation capture. The `invoked`
edge already covers explicit Skill-tool calls (`ingest/transcripts.ts`) AND slash-commands
(`ingest/commands.ts` namespaces `~/.claude/commands/` + per-repo `.claude/commands/`). The
genuinely uncaptured class is **auto-loaded skills**: pulled in by a subagent's `skills:`
frontmatter or injected by a SessionStart hook (e.g. `using-superpowers`) - they activate
with no Skill-tool call, so no `invoked` edge. `ax skills unused` already compensates for the
frontmatter case via `loadAgentScopeMap`, but writes no usage edge.

### Prerequisites before re-running

1. **Backfill `skill_revision`** from ingest history (or accrue organically). *Primary gate.*
2. **Capture auto-load activations** as a derived edge - when a subagent with `skills:`
   frontmatter spawns, or a SessionStart hook injects a skill, stamp an activation row
   (ts + session). *Secondary; a bounded derive-stage feature, NOT a hot-path parser change.
   Does not unblock the crux on its own - #1 is the gate.*

Until #1 lands, "ax = the open-ended verifier" cannot be tested, let alone claimed.

## Not in scope

- Building `ax verify` (gated on a positive result here).
- Per-skill-version attribution UI (the productized form, also gated on this).
- The protected-section invariant (panel verdict: non-problem for ax's human-gated edit loop).
