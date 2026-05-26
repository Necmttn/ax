---
name: ax-retro
description: Guided experiment-loop retrospective. Triggers when the user says "let's do an ax retro", "ax retrospective", "review my ax proposals", "triage proposals", "check experiment loop", "lock pending verdicts", "self-improvement session", or invokes /ax-retro. Walks the user through proposal triage (accept-with-scaffold or reject), verdict review (confirm or override the suggested verdict for due checkpoints), and a brief summary at the end. Reads/writes via the local `ax improve` CLI. Do NOT auto-trigger on unrelated work.
---

# ax retro - guided experiment-loop session

This skill turns the experiment-loop CLI (`ax improve …`) into a human-paced
review session. Claude orchestrates; the user decides each row.

Assumes `ax` (axctl) is on PATH and the local SurrealDB is running. If
`ax improve list` fails with a connection error, tell the user
`scripts/db-start.sh` and stop.

## When to fire

ONLY fire on explicit triggers:
- "let's do an ax retro" / "ax retrospective" / "retro time"
- "review my ax proposals" / "triage proposals"
- "what's my experiment loop status" / "lock pending verdicts"
- `/ax-retro` slash command (if present)

Do NOT fire on "look at my recent work" or general retrospectives - that
risks dragging unrelated context into the loop.

## Workflow

### Step 1 - Snapshot

Run silently:
```
ax improve list --status=open --json
ax improve list --status=accepted --json
```
Compute three counts: open proposals, accepted experiments, accepted
experiments whose `experiment.locked_verdict` is null and whose latest
checkpoint exists. Then run `ax improve verdict --json` to confirm the
verdict-pending list.

Render to the user as 2-4 lines, e.g.:

> 7 open proposals (3 skill, 4 guidance). 2 accepted experiments are
> waiting on a verdict. Want to triage proposals first, or lock the
> pending verdicts?

If both queues are empty: tell the user nothing's due and offer
`ax ingest --derive-only` to refresh evidence.

### Step 2 - Triage open proposals

Order open proposals by `frequency` desc. For each, in turn:

1. Run `ax improve show <dedupe_sig> --json` (or use the row from step 1).
2. Render as 3-5 lines. Example for a skill proposal:

   > **Schema change guardrail** (skill · freq=9 · confidence=high)
   > Hypothesis: schema edits often surface in fix-chains within ~14d.
   > Trigger: fix commits overlap SurrealDB schema files.
   > Behavior: run schema lint + one read/write smoke before edit.

3. Ask the user: **accept**, **reject**, or **skip**.
4. Branch:
   - **accept** → run `ax improve accept <dedupe_sig>`.
     Tell the user where the SKILL.md was scaffolded.
     Offer: *"Want to refine the scaffolded SKILL.md right now?"*
     If yes: read the file, propose edits, write them back. Then commit
     if appropriate.
   - **reject** → ask the user for a short reason (≤80 chars).
     Run `ax improve reject <dedupe_sig> --reason "<reason>"`.
   - **skip** → no command. Move on. The proposal stays open for next retro.

After the loop, summarize: *"Accepted 3, rejected 1, skipped 2."*

### Step 3 - Verdict review

For each experiment whose latest checkpoint is unlocked
(`locked_verdict IS NONE`), in age order:

1. Run `ax improve verdict <dedupe_sig>` to fetch the experiment + checkpoint
   history.
2. Render the most recent checkpoint as 2-3 lines:

   > **Schema change guardrail** - t+30 checkpoint
   > 12 opportunities in window, 8 addressed (66%). Suggested: **adopted**.

3. Ask the user to confirm the suggested verdict OR override:
   - adopted (artifact is doing real work)
   - ignored (user wrote it but never invoked it)
   - regressed (it made things worse)
   - partial (mixed signal - used some times)
   - no_longer_needed (pattern self-resolved; trigger stopped firing)

4. Run `ax improve verdict <dedupe_sig> --set <verdict>` to lock it.

### Step 4 - Close out

Output a one-paragraph summary:
- Counts: accepted / rejected / skipped / verdicts locked
- Any scaffolded SKILL.md files that still need refinement
- When the next retro is recommended. Compute as: earliest
  `experiment.created_at + 7d` among accepted-but-unlocked experiments,
  formatted as "next retro suggested around YYYY-MM-DD".

Then ask whether the user wants you to commit the scaffolded skill files +
the proposal-status changes (the DB is local, but the SKILL.md files are
on disk and may belong in version control).

## How to track feedback

The retro itself produces durable signal that the experiment loop already
captures:

- **Acceptance rate by form** - read from `proposal.status` after the
  session. If skill-form proposals get accepted 80% but guidance proposals
  get rejected 80%, the derive-proposals stage is over-eager on the wrong
  form; tell the user, suggest opening an issue.
- **Reject reasons** - the `proposal.reject_reason` field is a free-text
  corpus. After the session, run
  `ax improve list --status=rejected --json | jq '.[].reject_reason'`
  and look for repeated phrases (e.g. "duplicate of existing hook"). Tell
  the user when a pattern emerges - the derive-proposals stage should
  dedupe against it.
- **Verdict surprises** - when the user overrides a suggested verdict,
  note it. Repeated overrides mean the verdict math is biased; surface as
  a TODO.

These are observations, not actions. Don't write to insight tables - just
report them in the close-out.

## CLI reference Claude calls

```bash
ax improve list [--form=skill|subagent|hook|guidance|automation] \
                [--status=open|accepted|rejected|superseded|all] [--json]
ax improve show <dedupe_sig> [--json]
ax improve accept <dedupe_sig> [--force]
ax improve reject <dedupe_sig> --reason "<text>"
ax improve verdict [<dedupe_sig>] [--set <verdict>] [--json]
ax improve checkpoint [--force]
ax improve reset --yes                     # destructive; only when user requests
```

`--force` on `accept` overwrites an existing SKILL.md scaffold. Only use
when the user explicitly says so.

`reset --yes` wipes ALL proposal/experiment/checkpoint state. NEVER run
without explicit user confirmation in this session.

## Failure modes

- `ax improve list` returns empty → run `ax ingest --derive-only` once,
  retry. If still empty, evidence is genuinely thin; tell the user.
- `ax improve accept` reports `scaffold_exists` → ask the user if they
  want `--force` or to abandon.
- `ax improve verdict --set` reports `verdict_locked` → that experiment
  is already finalized; show the locked value and move on.
- DB connection refused → tell the user `scripts/db-start.sh`.

## Anti-patterns

- Don't dump raw JSON. Render summaries.
- Don't run `ax improve accept` for every open proposal in a batch; the
  user must say yes per row.
- Don't write to ~/.claude/skills/ directly. The CLI handles that.
- Don't propose deleting a scaffolded SKILL.md mid-retro; that's a
  separate cleanup task.
