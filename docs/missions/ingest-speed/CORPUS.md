# Frozen Benchmark Corpus

**FIXED for the whole ingest-speed mission. Do NOT change.** Every attempt
ingests exactly this subset so cold/warm numbers are comparable.

- Location (read-only via `HOME` override): `$HOME/.cache/ax-bench/home`
- Ingest reads `~/.claude/projects/` and `~/.codex/sessions/` (homedir-hardcoded
  in `packages/lib/src/transcript-locator.ts`); the bench harness sets
  `HOME=$BENCH_HOME` so those resolve into this frozen tree.
- Snapshotted via `rsync -a` from the real `~/.claude` / `~/.codex` (a copy - the
  real data is never an ingest target).

## Totals

| Tree | Size | Files |
|------|------|-------|
| `.claude` (7 project dirs) | 90 MB | 445 |
| `.codex` (1 day) | 3.8 MB | 2 |
| **total** | **~94 MB** | **447** |

Cold ingest (empty DB → full graph) on this subset: **~37 s** wall-clock
(comfortably in the tens-of-seconds target, not minutes).

## Claude project dirs (`$BENCH_HOME/.claude/projects/`)

Chosen to span size and project variety (ax, quera, apps, livetrace, ponto, seggy):

| dir | size |
|-----|------|
| `-Users-necmttn-Projects-ponto` | 4.5 MB |
| `-Users-necmttn-Projects-seggy-sales-agency-transcripts` | 9.5 MB |
| `-Users-necmttn-Projects-quera--claude-worktrees-delegate-phase-b-persistence` | 10 MB |
| `-Users-necmttn-Projects-ax--claude-worktrees-architecture-deepening` | 11 MB |
| `-Users-necmttn-Projects-ax--claude-worktrees-workflow-extraction-frictions` | 13 MB |
| `-Users-necmttn-Projects-livetrace` | 16 MB |
| `-Users-necmttn-Projects-apps` | 26 MB |

## Codex sessions (`$BENCH_HOME/.codex/sessions/`)

Full `2026/06/01` day (2 rollout JSONLs, 3.8 MB):

- `2026/06/01/rollout-2026-06-01T10-18-29-019e80f9-b729-7151-adbf-1f6cba2c7975.jsonl`
- `2026/06/01/rollout-2026-06-01T13-21-06-019e81a0-e69c-7061-b51e-552fda03980e.jsonl`

## Re-freeze (if ever needed - but keep the SAME set)

```bash
BENCH_HOME="$HOME/.cache/ax-bench/home"
mkdir -p "$BENCH_HOME/.claude/projects" "$BENCH_HOME/.codex/sessions/2026"
SRC="$HOME/.claude/projects"
for d in \
  -Users-necmttn-Projects-ponto \
  -Users-necmttn-Projects-seggy-sales-agency-transcripts \
  -Users-necmttn-Projects-quera--claude-worktrees-delegate-phase-b-persistence \
  -Users-necmttn-Projects-ax--claude-worktrees-architecture-deepening \
  -Users-necmttn-Projects-ax--claude-worktrees-workflow-extraction-frictions \
  -Users-necmttn-Projects-livetrace \
  -Users-necmttn-Projects-apps ; do
  rsync -a "$SRC/$d" "$BENCH_HOME/.claude/projects/"
done
rsync -a "$HOME/.codex/sessions/2026/06" "$BENCH_HOME/.codex/sessions/2026/"
```

> The corpus is NOT committed to git (too large + private). This file is the
> reproducible spec.
