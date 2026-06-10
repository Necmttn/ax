---
name: retro
description: Guided experiment-loop retrospective over the ax agent-experience graph. Walks the user through their open proposals (accept-with-scaffold or reject), pending verdicts (confirm the suggested verdict or override), and recent harness-hook effectiveness signal. Triggers when the user says "let's do an ax retro", "ax retrospective", "review my ax proposals", "triage proposals", "experiment loop status", "lock pending verdicts", "hook effectiveness review", "intervention review", "self-improvement session", or invokes /ax:retro. Reads/writes via the local `ax improve` and `ax hooks` CLIs. Do NOT auto-trigger on unrelated work.
---

# ax:retro - guided experiment-loop session

Closes the self-improvement loop. Claude orchestrates `ax improve …`
commands; the user decides each row.

Assumes `ax` (axctl) is on PATH and the local SurrealDB is running. If
`ax improve list` fails with a connection error, tell the user
`scripts/db-start.sh` and stop.

## When to fire

ONLY fire on explicit triggers:
- "let's do an ax retro" / "ax retrospective" / "retro time"
- "review my ax proposals" / "triage proposals"
- "what's my experiment loop status" / "lock pending verdicts"
- "hook effectiveness review" / "intervention review"
- "self-improvement session"
- `/ax:retro` slash command (if the plugin marketplace publishes one)

Do NOT fire on a generic "look at my recent work" - that risks dragging
unrelated context into the loop.

## Defaults

- Window for hook signals: last 7 days. Widen to 30 if evidence is sparse.
- Don't apply changes silently. Every accept/reject/verdict gets the
  user's explicit yes per row.
- The retro is read-mostly. Skill scaffolds + verdict locks are the only
  side-effects.

## Workflow

### Step 0 - Drain pending session retros

Before the proposal queue, check whether prior sessions still owe a
retro. This is the "quota arbitrage" path - idle Opus budget chews
through the backlog so the experiment loop has signal next time.

1. Run:

   ```bash
   ax retro pending --since=7 --idle-min=30 --json
   ```

   Returns sessions in the last 7 days that have no `reviewed` graph
   edge yet AND look finished (explicit `ended_at`, or last turn is
   >30min idle). If the list is empty, skip to Step 1.

2. Show the list to the user as 1 line per session (project · turns ·
   model · reason). Ask:

   > N session(s) pending retro. Want me to dispatch the
   > retro-reviewer subagent for all of them in parallel, or pick a
   > subset?

3. On `all` or `<subset>`: for each chosen session, write a brief:

   ```bash
   ax retro brief --session=<session_id>
   ```

   This writes `.ax/tasks/retro/<key>.md` with frontmatter (transcript
   path, suggested model, turn count, etc.) and a body that tells the
   reviewer what to do.

4. Dispatch one `retro-reviewer` subagent per brief, in parallel. Pass
   each brief path in the prompt; let the subagent's frontmatter pin
   `model: opus` (override per session if `suggested_model` differs and
   the user asked you to economize).

5. Wait for all subagents. Aggregate results: counts of retros emitted,
   proposals recommended, model-fit suggestions. Render as a short
   summary. The user does not approve retro emissions per row - the
   subagent already wrote them. The user DOES decide on resulting
   proposals in Step 2.

6. The `reviewed` edge now exists for each drained session, so a
   re-run of `ax retro pending` should show fewer rows.

If the user declines Step 0, move on. The backlog stays - next retro
picks it up.

### Step 1 - Snapshot

Run silently (parallel where possible):

```bash
ax improve list --status=open --json
ax improve list --status=accepted --json
ax improve verdict --json
ax retro list --since=7 --json         # cluster-derived friction summary
ax hooks summary --since=7 --tail=20   # optional; tolerate failure
```

`ax retro list` reflects three pattern types now:
- **tool failures** (skill form) -> `Pre-<Tool> guard` proposals
- **correction pressure** (guidance form) -> "Reduce recurring user
  corrections" proposals targeting `CLAUDE.md`
- **friction kinds** (skill form, one per kind) -> `Address recurring
  <kind> friction` proposals

If any of those surfaced, mention them so the user knows to triage in
Step 2.

Compute counts: open proposals (by form), accepted experiments with
`locked_verdict IS NONE`, checkpoints due since last lock. Then render
to the user as 2-4 lines, e.g.:

> 7 open proposals (3 skill, 4 guidance). 2 accepted experiments are
> waiting on a verdict. Hook activity last 7d: 142 invocations, 3
> blocking errors. Want to triage proposals first, lock the pending
> verdicts, or skim hook signals?

If both proposal/verdict queues are empty: tell the user nothing's due
and offer `ax ingest --derive-only` to refresh evidence.

### Step 2 - Triage open proposals

Order open proposals by `frequency` desc. For each, in turn:

1. Run `ax improve show <dedupe_sig> --json` (or reuse the row from
   step 1).
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
     If yes: read the file, propose edits, write them back.
   - **reject** → ask for a short reason (≤80 chars).
     Run `ax improve reject <dedupe_sig> --reason "<reason>"`.
   - **skip** → no command. Move on; the proposal stays open for the
     next retro.

After the loop, summarize: *"Accepted 3, rejected 1, skipped 2."*

### Step 3 - Verdict review

For each experiment whose latest checkpoint is unlocked
(`locked_verdict IS NONE`), in age order:

1. Run `ax improve verdict <dedupe_sig>` to fetch the experiment +
   checkpoint history.

2. Render the most recent checkpoint as 2-3 lines:

   > **Schema change guardrail** - t+30 checkpoint
   > 12 opportunities in window, 8 addressed (66%). Suggested: **adopted**.

3. Ask the user to confirm the suggested verdict OR override:
   - `adopted` (artifact is doing real work)
   - `ignored` (user wrote it but never invoked it)
   - `regressed` (it made things worse)
   - `partial` (mixed signal)
   - `no_longer_needed` (pattern self-resolved; trigger stopped firing)

4. Run `ax improve verdict <dedupe_sig> --set <verdict>` to lock it.

### Step 4 - Hook effectiveness pass (optional)

Only run if the user asked for hook review OR if step-1 found ≥3
blocking errors. Light touch - this section is read-only.

1. Show top hooks from `ax hooks summary --since=7 --tail=20` if not
   already shown.

2. If a hook keeps blocking, ask: *"Want to inspect a recent
   invocation?"* Then run
   `ax hooks invocations --command="<hook>" --tail=5` and render.

3. Backtest known feedback cases:

   ```bash
   ax hooks cases enforce-worktree --tail=50 --window=3
   ```

   Treat each backtest result as one case type. Report pass/fail/
   inconclusive counts.

4. Interpretation:
   - A blocking hook error is not automatically bad. If the next few
     agent actions show corrected behavior, it's a useful corrective
     signal.
   - A successful hook is not automatically useful. Look for downstream
     behavior change.
   - `hook_progress` without a terminal success/blocking event is a
     telemetry gap unless correlated with visible behavior.
   - Prefer deterministic backtests over model judgment.

### Step 5 - Close out

Output a one-paragraph summary:
- Counts: accepted / rejected / skipped / verdicts locked.
- Any scaffolded SKILL.md files that still need refinement.
- When the next retro is recommended. Compute: earliest
  `experiment.created_at + 7d` among accepted-but-unlocked
  experiments, formatted as "next retro suggested around YYYY-MM-DD".

Then ask whether the user wants to commit the scaffolded skill files +
proposal-status changes (DB is local, but SKILL.md files are on disk
and may belong in version control).

## How to track feedback

The retro itself produces durable signal that the experiment loop
already captures:

- **Acceptance rate by form** - after the session, derive from
  `proposal.status`. If skill-form gets accepted 80% but guidance gets
  rejected 80%, the derive-proposals stage is over-eager on the wrong
  form. Surface as an observation.
- **Reject reasons** - `proposal.reject_reason` is a free-text corpus.
  After the session run:

  ```bash
  ax improve list --status=rejected --json | jq '.[].reject_reason'
  ```

  Look for repeated phrases ("duplicate of existing hook"). When a
  pattern emerges, the derive-proposals stage should dedupe against it
  - tell the user.
- **Verdict surprises** - when the user overrides a suggested verdict,
  note it. Repeated overrides mean the verdict math is biased.

These are observations, not actions. Report in the close-out; don't
write to insight tables.

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

ax retro pending [--since=N] [--idle-min=N] [--json]   # Step 0 backlog
ax retro brief --session=<id> [--out-dir=<path>] [--json]
ax retro emit --session=<id> [--source=<src>] [--from-file=<json>]
ax retro list [--since=N] [--limit=N] [--json]

ax hooks summary [--since=N] [--tail=N]
ax hooks invocations [--command="<name>"] [--tail=N]
ax hooks cases <case-name> [--tail=N] [--window=N]
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
- `ax hooks summary` returns nothing → retry with `--since=30`; if
  still empty, the hook telemetry pipeline is idle, surface as a TODO.
- DB connection refused → tell the user `scripts/db-start.sh`.

## Anti-patterns

- Don't dump raw JSON. Render summaries.
- Don't run `ax improve accept` for every open proposal in a batch; the
  user must say yes per row.
- Don't write to `~/.claude/skills/` directly. The CLI handles that.
- Don't propose deleting a scaffolded SKILL.md mid-retro; that's a
  separate cleanup task.
- Don't auto-implement experiments from the hook pass. Recommendations
  only; the user decides + commits.
