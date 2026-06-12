# ax routing tune - launch copy (2026-06-12)

Numbers measured on the author's machine, 14-day window ending 2026-06-12
(30d for the tune mining figure). Refresh before publishing if stale.

## X/Twitter thread (7 posts)

**Post 1**

My agent bill for the last 14 days: $19,270.

663 subagent dispatches. 75% inherited the frontier model because nobody pinned one.

File searches billed at opus rates.

I built the fix into ax. The last piece shipped today.

**Post 2**

The failure mode: any subagent dispatch that doesn't pin a model inherits the expensive one.

On my machine: $2,301 of subagent spend on fable/opus vs $83 on sonnet. That's 28:1.

Most of it was mechanical work. File search. Spec'd implementation. Bug fixes.

**Post 3**

The loop:

MEASURE - ax cost split breaks spend into main loop vs subagents, by model.

NUDGE - a route-dispatch hook warns at dispatch time when a mechanical dispatch forgets to pin a model.

That got me partway. The routing table was still hand-written.

**Post 4**

Shipped today: ax routing tune.

It mines your own dispatch history for new routing classes. Deterministic clustering, no LLM in the loop.

First run on my data: 20 new classes, $591.57 of addressable spend over 30 days.

[SCREENSHOT: ax routing tune --dry-run output, cropped to footer]

**Post 5**

VERIFY - ax dispatches --candidates reprices every expensive inherited dispatch against the updated table.

Current table: $512.91 in flagged savings, repriced from the real token buckets those dispatches burned.

[SCREENSHOT: ax dispatches --candidates output, cropped to footer]

**Post 6**

Judgment work never auto-tiers down.

Code review, design, planning, audits - the miner detects these and routes the proposal through a brief your agent adversarially backtests before anything applies.

Quality stays on the frontier model. Only mechanical work moves.

**Post 7**

Everything runs local. Your transcripts never leave your machine.

curl -fsSL https://ax.necmttn.com/install | bash
then: ax routing tune

github.com/Necmttn/ax

[GIF: tune apply loop]

## Standalone tweet

14 days, $19,270 of agent spend. 75% of my 663 subagent dispatches inherited the frontier model by default.

Shipped today: ax routing tune mines your own dispatch history for routing classes. 20 classes, $591.57/30d addressable on my machine. Local-only.

github.com/Necmttn/ax

## LinkedIn post

I published my own AI agent bill: $19,270 over 14 days.

The expensive part wasn't the hard work. When you orchestrate with subagents, any dispatch that doesn't pin a model inherits the frontier one. On my machine, 75% of 663 dispatches did exactly that. File searches and spec'd bug fixes were billed at opus rates: $2,301 on frontier models vs $83 on sonnet.

Today I shipped the last piece of the fix in ax, my local telemetry graph for coding agents. `ax routing tune` mines your own dispatch history for routing classes - deterministic clustering, no LLM involved. First run found 20 classes covering $591.57 of addressable spend in 30 days. `ax dispatches --candidates` then reprices against real token buckets: $512.91 flagged.

One rule: judgment work (review, design, planning) never auto-routes to cheaper models. Only mechanical work tiers down.

All local. github.com/Necmttn/ax

## Production notes

- Crop both screenshots to the footer lines (totals + top classes) so dollar figures read at mobile width.
- Post 6 is the objection-killer ("won't quality drop") - keep it late in the thread but never cut it.
- "addressable spend" for the tune figure, "flagged/est savings" for candidates - never "realized savings" (retrospective repricing, per PR #312 semantics).
- GIF: VHS tape of dispatches --candidates -> routing tune -> applied diff -> savings footer (sub-project B plan).
