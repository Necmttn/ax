# Agent-driven first ingest + Paxel-grade progress

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

1. **Install blocks on a long, opaque process.** First-run ingest takes minutes
   with no ETA and no escape. Users drop off staring at a frozen terminal.
2. **The progress we do show is coarse.** Compared to the reference (YC Paxel's
   first-run analysis), ax lacks an up-front ETA, per-item metering, throughput
   (it/s), time-remaining, and a dashboard-mirrored live view.

### Reference: YC Paxel first run (the bar to clear)

- Counts sources first, prints **per-source + total ETA**, gates on `Continue?`
- Numbered pipeline steps `[7/17]`
- Live bar: `⠧ [7/17] Summarizing 115/287  1.8 it/s  ██▊░ 11%  01:17 elapsed · ~10:04 left`
- Local cache → reruns skip completed work

## Goal

Install/setup finishes fast. The onboarding **agent** drives ingest as a narrated
step: show an ETA, run it in the background, point the user at a **live dashboard
that renders a Paxel-grade progress bar**, then summarize takeaways. `ax update`
stops ingesting (schema still re-applies, which is correct). The same rich
progress renders in every context - foreground TUI, plain log (agent-tailed), and
the dashboard.

## Decisions

- **Orchestration: agent-driven via the brief.** CLI provides primitives; the
  pasted onboarding prompt sequences them and narrates.
- **ETA: quick sample calibration, always.** No prior-run data exists on the run
  that matters most (first run), so estimate on *this machine* by sampling.
- **Background: the agent's own backgrounding.** No new `--background` flag, no
  status file. The agent launches `ax ingest` with `Bash(run_in_background)`,
  tails the log for progress + exit, and summarizes via existing queries.
- **Remove inline ingest from `cmdSetup` entirely** (not gate it). Revert the
  `dbHasSessions` probe added earlier in this branch - dead code once the call is
  gone.
- **Upgrade progress to Paxel-grade and mirror it everywhere** - item-level
  metering (current/total), it/s, ETA-remaining, numbered steps; rendered by the
  TTY TUI, the plain log, and the `ax serve` dashboard from one shared model.

## Components

### 1. `cmdSetup` - drop inline ingest

`apps/axctl/src/cli/install.ts`

Setup becomes: agent-skills install → (schema/daemon already done by `cmdInstall`)
→ `cmdDoctor` → render brief. The step-2 ingest block is removed.

Safety net for users who never paste the brief into an agent - print, don't run:

```
  ingest: not run yet. populate the graph with:
          ax ingest --dry-run   # see ETA
          ax ingest             # full backfill (watch live in ax serve)
          ...or the 04:00 daily sync fills it overnight.
```

Watcher (`--since=1` deltas) + daily full ETL cron are the non-agent fallbacks;
no new daemon work. **Revert** `dbHasSessions` + the populated-DB gate.

### 2. Progress model upgrade (shared core)

`apps/axctl/src/cli/progress.ts` (+ `progress-tui.tsx`), `ingest/stage/*`

Today `ProgressReporter` carries `update(stage, counts)` with arbitrary counts and
already guards against throughput noise on sub-threshold stages. Extend the model
so every render target can show the Paxel line:

- **Per-stage total + current.** Stages declare a `total` when known (source
  stages: counted files; derive stages: a cheap `count()` at stage start) and
  report `current` via `update`. Stages with no meaningful total degrade to the
  current spinner (no fake %).
- **Throughput + ETA-remaining.** Reporter derives `it/s` from Δcurrent/Δt
  (reusing the existing noise floor) and `etaLeftMs` from
  `(total − current) / rate`, aggregated across remaining stages weighted by their
  declared totals. Overall `[n/N]` from stage index / stage count.
- **One snapshot type** consumed by all three renderers (below), so the bar is
  identical everywhere: `⠧ [7/17] Summarizing 115/287  1.8 it/s  ██▊ 11%  01:17 · ~10:04 left`.

Render targets:
- **TTY TUI** (`progress-tui.tsx`) - foreground bar.
- **Plain mode** (`AX_PROGRESS=plain`) - same fields, one line per tick/stage,
  newline-delimited so an agent tailing the log parses progress + completion.
- **Dashboard** - see §4.

### 3. `ax ingest --dry-run [--json]` - ETA via sample calibration

New flag on the `ingest` command (`apps/axctl/src/cli/index.ts` + `ingest/run.ts`).

1. **Count pending sources** cheaply by globbing per-harness stores
   (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.pi/agent/sessions/`,
   OpenCode + Cursor SQLite row counts). No DB writes, no transcript parsing.
2. **Sample-calibrate (always):** ingest a small real slice (~30 sessions) through
   the normal pipeline, timed. Idempotent upserts → the slice is reused by the
   real run, no wasted work. Derive items/sec.
3. **Extrapolate** to the full counted total → `etaSeconds`.
4. Human output mirrors Paxel's up-front estimate (per-source + total):
   ```
   ax ingest --dry-run
     counting sources...
       claude   1,180 sessions
       codex      60 sessions
       cursor      0
     calibrating... sampled 30 in 2.1s  (14.3/s)
     total: 1,240 sessions, ~38k turns   ETA ~3m30s on this machine
     run it: ax ingest   (watch live in ax serve → http://127.0.0.1:8520)
   ```
   `--json`:
   ```json
   { "sources": { "claude": 1180, "codex": 60, "cursor": 0, "sessionsTotal": 1240, "turnsTotal": 38000 },
     "sampled": { "items": 30, "seconds": 2.1 }, "ratePerSec": 14.3, "etaSeconds": 210 }
   ```
   The agent reads `--json` to narrate ETA and to compute live progress while
   polling (current DB session count ÷ `sources.sessionsTotal`).

### 4. Dashboard mirror - `stage_progress` stream event

`apps/axctl/src/ingest/stream-events.ts`, `dashboard/ingest-stream.ts`, web UI

Stream events are currently coarse (`run_started`, `stage_started`,
`stage_finished`, `run_finished`). Add:

```ts
| { kind: "stage_progress"; runId: string; stage: string;
    current: number; total: number; ratePerSec: number;
    stageIndex: number; stageCount: number; etaLeftMs: number }
```

The progress reporter publishes it through the existing `IngestStreamBus` →
durable stream `ingest:<runId>`; the Live tab renders the same bar from the same
fields. Subscribe-from-`-1` rehydration is unchanged.

**Caveat (documented, not solved here):** server-forked ingest (POST /api/ingest)
only works running from source; the compiled binary returns 503 (native lmdb).
For installed/compiled users the agent backgrounds the **CLI** ingest, which does
*not* publish to the serve process's in-memory bus - so the dashboard reflects the
**growing graph** (session counts climbing), while the rich live bar appears in
the agent-tailed terminal log. Unifying CLI→dashboard progress for compiled builds
is out of scope (would need a file/IPC progress sink).

### 5. Onboarding brief - new leading step

`packages/lib/src/agent-onboarding.ts` (`AGENT_ONBOARDING_PROMPT`). Prepend:

```
1. INGEST MY HISTORY -
   - Run `ax ingest --dry-run` and tell me the ETA in plain words.
   - Start the ingest in the BACKGROUND (so we can keep talking):
     run `ax ingest` with AX_PROGRESS=plain as a background job.
   - Tell me to watch it fill live: `ax serve` → http://127.0.0.1:8520
   - Poll the background job; report milestones; when it finishes, summarize
     what landed: total sessions, turns, and the top skills/tools I use.
   - THEN continue with verify / label / show below.
```

Existing steps renumber after it. The brief stays the single source of truth
(`ax setup --agent-prompt`, install.sh, site copy button).

## Data flow

```
ax update / ax setup
  └─ cmdSetup: skills + doctor + render brief   (fast, no ingest)
       └─ user pastes brief into Claude Code / Codex
            └─ agent: ax ingest --dry-run --json     → ETA + per-source counts
               agent: Bash(run_in_background) AX_PROGRESS=plain ax ingest
                  → plain log: ⠧ [7/17] Summarizing 115/287 1.8 it/s … ~10:04 left
               agent: "watch ax serve → :8520"  (graph fills; bar if source-run)
               agent: poll log / session count vs total → milestones
               agent (on exit): ax skills weighted → takeaways summary
                 → proceeds to verify / label / show
```

## Error handling

- **Dry-run, no sources:** "nothing to ingest yet", ETA 0; agent skips the run.
- **Sample fails** (one bad transcript): catch, fall back to a coarse band
  ("a few minutes"); real ingest surfaces per-item errors as today.
- **Stage with unknown total:** spinner only, no fabricated %/ETA.
- **Background ingest exits non-zero:** agent sees it in the tailed log / task
  exit, reports "ingest exited N - run `ax ingest` manually", continues onboarding.
- **`ax update`:** unchanged except no ingest; `cmdInstall` still re-applies schema.

## Testing

- `cmdSetup` no longer spawns `ingest` (assert no spawn; brief + next-step line
  present). Update `install.test.ts`.
- Progress model: given stage totals + a stubbed clock, `it/s`, `%`, `etaLeftMs`,
  `[n/N]` are deterministic; sub-threshold stages emit no fake throughput.
- One snapshot → identical fields across TUI / plain / `stage_progress` event
  (assert the serializer, not three renderers).
- `ax ingest --dry-run --json` shape: per-source counts, finite `etaSeconds`,
  `ratePerSec > 0` after a sampled slice; ETA 0 on empty sources.
- Source-counting helpers per harness against fixture dirs (cheap globs / row
  counts, no DB).

## Out of scope

- **Source/repo selection menu** + `Continue? [Y/n]` gate (Paxel has them) - the
  agent narrates the ETA and proceeds; `ingest here` already scopes. Defer.
- `ax ingest --background` / status file / `ax ingest status` - agent backgrounds
  it instead.
- Unifying compiled-binary CLI ingest progress into the dashboard (needs a
  file/IPC progress sink; §4 caveat).
- Persisting throughput across runs - re-sample each dry-run; the case that
  matters (first run) has no history.
- Cache/"skipped N completed" surfacing - idempotent upserts already no-op;
  surfacing them as skips is a later polish.
