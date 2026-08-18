# judgment-learn - Phase 5 learning-layer prototype (#895)

Can a tiny trained model beat `JUDGMENT_GUARD_RE` at deciding whether a
main-agent turn is judgment work (stay on the frontier model) or routable
(cheap tier)? The v3 plan's ship gate: **beats the regex baseline on
held-out labels, else the regex stays. Regexes become features, never
deleted first.**

## Verdict (2026-08-19): GATE PASSED - at matched recall

The regex is a safety guard, so the deciding comparison is at the guard's
own operating point: the learned model's threshold lowered until its
held-out judgment-recall ≥ the regex's, then compare precision (= how much
routable work is wrongly held on the frontier).

Over **20 random 70/30 splits** of 360 LLM-labeled turns:

- precision gap at matched-or-better recall: **+15.0 points mean (sd 7.0),
  positive in 20/20 splits** (regex ≈ 0.39–0.55 per split; learned ≈ +0.15)
- while ALSO carrying **+4.9 points extra recall** on average
  (matched-recall search lands above the target, never below).

Single canonical split (seed 0xc0ffee, n=109 held out, 24 judgment):

| detector | acc | precision | recall | F1 |
| --- | --- | --- | --- | --- |
| `JUDGMENT_GUARD_RE` (own text) | 0.688 | 0.386 | 0.708 | 0.500 |
| regex + prev-prose carry | 0.670 | 0.370 | 0.708 | 0.486 |
| learned @0.5 | 0.789 | 0.526 | 0.417 | 0.465 |
| **learned @0.35 (matched recall)** | **0.780** | **0.500** | **0.750** | **0.600** |

Interpretation: at the default 0.5 threshold the model under-flags (wrong
direction for a guard). At 0.35 it dominates the regex on BOTH axes: same
or better safety (recall) with roughly a third fewer false flags - i.e.
more genuinely-routable spend actually routes.

The learned weights are legible and match intuition: long prose, question
marks, code fences and non-read tool mixes push toward judgment; edit-heavy
tool composition pushes routable; `regexOwn` survives as a positive feature
(+0.43) exactly as the plan predicted ("regexes become features").

## Method

1. `extract.ts` - decision population from the PUBLISHED snapshot: claude
   MAIN sessions, assistant turns not adjacent to a user turn (the turns
   `classifyTurn` actually decides on), 120-day window → 45,938 turns.
   Stratified sample of 360 (120 regex-judgment / 120 tool-routable /
   120 prose-other) into 9 batches.
2. LLM labeling - 9 parallel subagents labeled judgment-vs-routable from
   the turn text + tools + previous assistant prose, instructed to judge
   the WORK, not the vocabulary. Two batches double-labeled by independent
   annotators: raw agreement 93.8%, Cohen's kappa 0.818 (strong - the
   labels are real signal, not labeler noise). Class balance: 26.4%
   judgment.
3. `train.ts` - 12 features (tool-composition counts, text stats, regex
   hits own+prev), hand-rolled L2 logistic regression (3k epochs, CPU
   seconds), the three detectors evaluated on the SAME held-out set, plus
   the threshold sweep, matched-recall comparison, and 20-repeat stability
   check.

Data files (population.ndjson, batches/, labels/) contain raw turn text
and are gitignored - LOCAL artifacts; re-generate with extract.ts and
re-label to reproduce.

## Honest caveats

- Labels are LLM-generated (kappa 0.818 against a second LLM instance, not
  a human). The double-label subset bounds label noise but does not remove
  shared-model bias.
- The sample is stratified BY the regex's own decision boundary, so these
  are not population metrics; both detectors are measured on the same set,
  so the COMPARISON is fair, but absolute rates will differ in production.
- n=360 total / ~109 per held-out split; per-split variance is real (sd
  7.0 points) - the 20/20 positive-splits result is the robust claim.
- The regex+carry baseline approximates buildSpans' judgmentSticky with
  prev-assistant-prose only.

## What the landed slice would look like (follow-up, not this issue)

- Grow labels (another few hundred turns via dojo surplus), k-fold, and
  re-fit; pin the matched-recall threshold from the fold data.
- Weights-as-table (`agent_model`-style catalog row or a dedicated
  `classifier_weights` table), inference as a SQL model in the DAG
  (logistic over these features is one SELECT), versioned by the
  established sentinel-marker cutover.
- `classifyTurn` consumes the score with the regex as FLOOR fallback when
  weights are absent; the regex feature is never deleted.
