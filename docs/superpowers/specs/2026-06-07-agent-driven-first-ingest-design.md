# Agent-driven first ingest

**Date:** 2026-06-07
**Status:** design, pending review

## Problem

`ax update` re-runs a full backfill ingest. Flow:

```
ax update → install.sh (AXCTL_VERSION=latest)
  → axctl install → cmdSetup({fromInstall}) → spawnSync("ingest")  # full, no --since
```

`cmdSetup` always runs a **full** `ax ingest` inline. Correct on a fresh install,
wrong on update: the DB is already populated, the watcher keeps it incremental,
and the daily 04:00 ETL cron does full backfills. Update fires a redundant
multi-minute full scan.

Two deeper issues this exposes:

1. **Install blocks on a long process.** First-run ingest can take minutes with
   no ETA and no escape. Users drop off staring at a frozen terminal.
2. **No onboarding narration.** The long step has no "here's how long, go look at
   the dashboard, here's what we found" arc.

## Goal

Install/setup finishes fast. The onboarding **agent** drives ingest as a narrated
step: show an ETA, run it in the background, point the user at the live dashboard,
then summarize takeaways. `ax update` stops ingesting entirely (schema still
re-applies, which is correct).

## Decisions

- **Orchestration: agent-driven via the brief.** The CLI provides primitives; the
  pasted onboarding prompt sequences them and narrates.
- **ETA: quick sample calibration, always.** No prior-run data exists on the run
  that matters most (first run), so estimate on *this machine* by sampling.
- **Background: the agent's own backgrounding.** No new `--background` flag, no
  status file. The agent launches `ax ingest` with `Bash(run_in_background)`,
  tails the log for progress + exit, and summarizes via existing queries.
- **Remove inline ingest from `cmdSetup` entirely** (not gate it). Absence of the
  call fixes the update bug directly; no runtime DB check needed.

## Components

### 1. `cmdSetup` - drop inline ingest

`apps/axctl/src/cli/install.ts`

Setup becomes: agent-skills install → (schema/daemon already done by `cmdInstall`)
→ `cmdDoctor` → render brief. The step-2 ingest block is removed.

Safety net for users who never paste the brief into an agent: print a one-line
next-step instead of running ingest -

```
  ingest: not run yet. populate the graph with:
          ax ingest            # full backfill (see ETA: ax ingest --dry-run)
          ...or the 04:00 daily sync will fill it overnight.
```

The watcher (`--since=1` deltas) and the daily full ETL cron already exist as the
non-agent fallbacks; no new daemon work.

**Revert** the `dbHasSessions` probe + populated-DB gate added earlier in this
branch - dead once the inline ingest call is gone.

### 2. `ax ingest --dry-run [--json]` - ETA via sample calibration

New flag on the existing `ingest` command (`apps/axctl/src/cli/index.ts` +
`apps/axctl/src/ingest/run.ts`).

Behaviour:

1. **Count pending sources** cheaply by globbing the per-harness session stores
   (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`,
   OpenCode + Cursor SQLite). No DB writes, no parsing - file/row counts only.
2. **Sample-calibrate (always):** ingest a small real slice (~30 sessions) through
   the normal pipeline, timed. Upserts are idempotent, so the slice is reused by
   the subsequent real run - no wasted work. Derive items/sec.
3. **Extrapolate** to the full counted total → `etaSeconds`.
4. Print a human summary; `--json` emits:
   ```json
   { "sources": { "sessions": 1240, "turns": 38000, "...": 0 },
     "sampled": { "items": 30, "seconds": 2.1 },
     "ratePerSec": 14.3, "etaSeconds": 210 }
   ```
   The agent reads `--json` to narrate ETA and to compute live progress while
   polling (current DB session count ÷ `sources.sessions`).

Human output:

```
ax ingest --dry-run
  counting sources... 1,240 sessions, 38k turns
  calibrating... sampled 30 in 2.1s
  ETA: ~3m30s on this machine
  run it: ax ingest   (watch live in ax serve → http://127.0.0.1:8520)
```

### 3. Onboarding brief - new leading step

`packages/lib/src/agent-onboarding.ts` (`AGENT_ONBOARDING_PROMPT`). Prepend:

```
1. INGEST MY HISTORY -
   - Run `ax ingest --dry-run` and tell me the ETA in plain words.
   - Then start the ingest in the BACKGROUND (so we can keep talking):
     run `ax ingest` (set AX_PROGRESS=plain) as a background job.
   - Tell me to watch it fill live: `ax serve` → http://127.0.0.1:8520
   - Poll the background job's progress; when it finishes, summarize what
     landed: total sessions, turns, and the top skills/tools I actually use.
   - THEN continue with verify / label / show below.
```

Existing steps (verify → label → show → next-step) renumber after it. The brief
stays the single source of truth (CLI `ax setup --agent-prompt`, install.sh, site
copy button all consume it).

## Data flow

```
ax update / ax setup
  └─ cmdSetup: skills + doctor + render brief   (fast, no ingest)
       └─ user pastes brief into Claude Code / Codex
            └─ agent: ax ingest --dry-run --json   → ETA + counts
               agent: Bash(run_in_background) AX_PROGRESS=plain ax ingest
               agent: "watch ax serve → :8520"
               agent: poll log / session count vs total
               agent (on exit): ax skills weighted → takeaways summary
                 → proceeds to verify / label / show
```

`ax serve`'s dashboard reflects the **growing graph** (session counts climbing as
the detached CLI commits rows) - not a live progress bar from that process. The
agent owns the numeric progress via the dry-run total + log tail.

## Error handling

- **Dry-run, no sources:** print "nothing to ingest yet" and ETA 0; agent skips
  the background run.
- **Sample fails** (e.g. one bad transcript): catch, fall back to a coarse band
  ("a few minutes") rather than aborting the dry-run; real ingest surfaces the
  per-item error as today.
- **Background ingest exits non-zero:** the agent sees it in the tailed log /
  task exit and reports "ingest exited N - run `ax ingest` manually", then still
  continues onboarding.
- **`ax update` path:** unchanged except no ingest. `cmdInstall` still re-applies
  schema (correct - migrations land on update).

## Testing

- `cmdSetup` no longer spawns `ingest` (assert no ingest spawn; brief rendered;
  next-step line present). Update existing `install.test.ts`.
- `ax ingest --dry-run --json` shape: counts present, `etaSeconds` finite,
  `ratePerSec > 0` given a sampled slice; ETA 0 with empty sources.
- Source-counting helpers unit-tested per harness against fixture dirs (cheap
  globs / row counts, no DB).
- Sample calibration: with a fixture of N sessions and a stubbed clock, rate and
  extrapolation math are deterministic.

## Out of scope

- `ax ingest --background` / status-file / `ax ingest status` (agent backgrounds
  it instead).
- Server-forked live-progress onboarding (`ax serve` POST /api/ingest) - excluded
  because the compiled binary returns 503 (native lmdb can't bundle).
- Persisting throughput across runs - the chosen flow re-samples each dry-run;
  the case that matters (first run) has no history anyway.
