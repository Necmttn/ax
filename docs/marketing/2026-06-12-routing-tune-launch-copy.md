# ax routing tune - launch copy (2026-06-12)

## v2 - post-feedback

Rewritten after user testing. Key changes: the misconception ("Claude Code
already downshifts for sub-tasks") leads; all jargon killed in the thread
(no "pin a model", no "dispatch", no "mines", no "routing classes");
burn-rate/usage-limit framing for the Max audience. v1 is in git history.

Numbers measured on the author's machine, 14-day window ending 2026-06-12
(30d for the tune mining figure). Refresh before publishing if stale.

## X/Twitter thread (7 posts)

**Post 1** [IMAGE: 16:9 receipt visual]

![receipt visual 16:9](./2026-06-12-receipt-visual-wide.png)

You'd think Claude Code sends the grunt work it spawns to cheaper models. It doesn't. Every sub-task runs on your most expensive model unless something tells it otherwise.

My last 14 days: $19,270. 663 sub-tasks. 75% on the priciest model for no reason.

**Post 2**

That's why your weekly usage limit dies in a couple of hours instead of lasting the week.

On my machine: $2,301 of sub-task spend on fable/opus vs $83 on sonnet. 28:1.

Most of it was routine. File searches. Spec'd implementations. Bug fixes.

**Post 3**

The fix: ax lets your harness switch models automatically.

The smart model keeps the thinking - planning, judgment, review. The routine implementation work it spawns goes to cheaper models.

You don't change how you work. The bill changes.

**Post 4** [SCREENSHOT: ax routing tune --dry-run output]

![tune dry-run screenshot](./2026-06-12-shot-tune-dryrun.png)

Shipped today: ax routing tune.

It reads your own usage history and finds the routine work that keeps getting billed at top rates. No AI guessing - just deterministic pattern-matching.

First run on my data: 20 patterns, $591.57 of addressable spend over 30 days.

**Post 5** [SCREENSHOT: ax dispatches --candidates output]

![candidates screenshot](./2026-06-12-shot-candidates.png)

Then the receipts: every sub-task that ran on the expensive model gets repriced against what the cheaper one would have cost, from the actual tokens it burned.

On my machine right now: $512.91 flagged.

**Post 6**

Work that needs judgment never moves. Code review, design, planning, audits - always on the smart model.

Only the routine work gets cheaper. Quality doesn't drop; the meter just stops running on file searches.

**Post 7** [LINK CARD: ax.necmttn.com/routing]

Everything runs on your machine. Your transcripts never leave it.

curl -fsSL https://ax.necmttn.com/install | bash
then: ax routing tune

Full breakdown: ax.necmttn.com/routing

## Standalone tweet

My last 14 days of Claude Code: $19,270. 75% of the 663 sub-tasks it spawned ran on the most expensive model - file searches billed at opus rates.

It doesn't downshift on its own. ax does it for you: smart model thinks, cheaper models grind. Local-only.

github.com/Necmttn/ax

## LinkedIn post

Most people assume Claude Code automatically uses cheaper models for the routine work it spawns - the file searches, the spec'd bug fixes. It doesn't. Every sub-task inherits your default model, which is usually the most expensive one. That's why a weekly usage limit that should last the week is gone in a couple of hours.

I measured it on my own machine: $19,270 of agent spend in 14 days. 663 sub-tasks, 75% on the top-tier model. $2,301 of that routine work billed at frontier rates vs $83 on sonnet - 28:1, for work that mostly didn't need the smart model.

Today I shipped the fix in ax, my local telemetry tool for coding agents. ax lets your harness switch models automatically: the smart model keeps the thinking - planning, review, design - and the routine implementation work goes to cheaper models. `ax routing tune` reads your own usage history and finds the kinds of routine work being overbilled. First run: 20 patterns, $591.57 of addressable spend over 30 days. Then it reprices every overbilled sub-task against the actual tokens it burned: $512.91 flagged on my machine.

One hard rule: judgment work never auto-downgrades. Quality stays where it was. Only the grunt work gets cheaper.

Everything runs locally. Your transcripts never leave your machine. github.com/Necmttn/ax

## 16:9 image - right panel lines

Plain-language overlay text, in order:

1. $19,270 in 14 days of agent spend
2. 663 sub-tasks - 75% ran on the most expensive model
3. `$ ax routing tune` - finds the routine work you're overpaying for

## Production notes

- Post 1 carries the receipt visual; posts 4 and 5 carry the cropped CLI
  screenshots; post 7 carries the ax.necmttn.com/routing link card.
- Crop both screenshots to the footer lines (totals + top patterns) so dollar
  figures read at mobile width.
- Post 6 is the objection-killer ("won't quality drop") - keep it late in the
  thread but never cut it.
- "addressable spend" for the tune figure, "flagged" for candidates - never
  "realized savings" (retrospective repricing, per PR #312 semantics).
- Thread vocabulary is locked plain: "sub-tasks", "routine work", "switch
  models automatically". The /routing page may keep precise terms (dispatch,
  routing classes); the thread may not.
- GIF (optional, replaces post 7 link card only if the card renders badly):
  VHS tape of candidates -> tune -> applied diff -> savings footer.
