# Mission Brief - Ingestion Speed Optimization

> **Assignee:** an autonomous agent / `/loop` / agent fleet.
> **Type:** measurement-driven optimization loop. **Min effort:** ≥ 100 benchmarked attempts.
> **Owner approval needed only at:** merging a winning change back to `main`.

## Mission

Make `ax ingest` **faster** - lower wall-clock time to ingest a fixed corpus - **without
changing the output graph**. Every attempt is benchmarked against a frozen corpus on a
disposable, isolated SurrealDB; results are logged to a ledger and compared so the loop
converges on real wins instead of guesses.

## Success criteria (definition of done)

- A **baseline** is recorded (current `main`, frozen corpus, isolated DB, median of N runs).
- **≥ 100 attempts** are run and logged in the ledger (`ATTEMPTS.md`), each with a hypothesis,
  the change, the measured median time, Δ vs baseline, Δ vs best-so-far, and a correctness verdict.
- At least the **top 3 confirmed wins** (faster AND output-equivalent AND tests green) are
  isolated as clean, separately-reviewable commits/patches with before/after numbers.
- A **final report** (`REPORT.md`) summarizes: baseline, the leaderboard, what worked, what
  didn't (with numbers), the bottleneck map, and a recommended merge set.
- No change is accepted that regresses correctness or the test suite. Faster-but-wrong = rejected.

**Primary metric:** median wall-clock for the full benchmark ingest (cold + warm runs reported
separately). **Secondary:** per-stage durations (find/shrink the bottleneck), peak RSS, total
SurrealDB queries. **Guardrail metric:** output-graph equivalence (see Correctness Gate).

## Hard constraints

1. **Isolation - never touch the user's real or dev data.**
   - Work in a **dedicated git worktree** (not `main`, not the live-ingest worktree).
   - Use a **dedicated, disposable SurrealDB instance** on its own port + data dir. Never connect
     to `:8521` (stable) or `:8522` (ax-dev).
   - Use a **frozen input corpus** (a one-time snapshot) so every run sees identical input.
2. **Correctness is non-negotiable.** Each accepted attempt must produce the same graph as baseline
   (see Correctness Gate) and keep `bun test` + `bun run typecheck` green.
3. **Measure, don't guess.** Profile to find the bottleneck before changing it. Every attempt is
   benchmarked and logged before keeping or reverting.
4. **One change per attempt.** Isolate variables so a delta is attributable. Revert losers.
5. **≥ 100 attempts**, recorded in the ledger even when they fail or regress (negative results are data).

---

## 1. Environment setup (do once)

### 1a. Worktree

```bash
cd /Users/necmttn/Projects/ax
git worktree add .claude/worktrees/ingest-speed -b perf/ingest-speed
cd .claude/worktrees/ingest-speed
bun install
```

### 1b. Frozen benchmark corpus

The transcript locator reads `~/.claude/projects/` and `~/.codex/sessions/` (homedir-hardcoded,
see `packages/lib/src/transcript-locator.ts`). Freeze a snapshot and point `HOME` at it so input is
constant and isolated:

```bash
export BENCH_HOME="$HOME/.cache/ax-bench/home"
mkdir -p "$BENCH_HOME/.claude" "$BENCH_HOME/.codex"
rsync -a --delete "$HOME/.claude/projects" "$BENCH_HOME/.claude/"   # freeze Claude transcripts
rsync -a --delete "$HOME/.codex/sessions"  "$BENCH_HOME/.codex/"    # freeze Codex sessions
# (optional) trim to a representative subset for faster iteration; keep it FIXED once chosen.
du -sh "$BENCH_HOME/.claude" "$BENCH_HOME/.codex"   # record corpus size in the ledger
```

Snapshot once, then treat it as read-only for the whole mission. Record its byte size + file count
in `ATTEMPTS.md` so the baseline is reproducible.

### 1c. Disposable benchmark SurrealDB

Reuse `scripts/db-start.sh` (reads `AX_DATA_DIR`, `AX_DB_PORT`, RocksDB tuning envs, `AX_SURREAL_BIN`).
Use a unique port + data dir; point `AX_SURREAL_BIN` at the vendored binary (HOME is overridden):

```bash
export BENCH_PORT=8531
export BENCH_DATA="$HOME/.cache/ax-bench/db"
export AX_SURREAL_BIN="$HOME/.local/share/ax/bin/surreal"   # real surreal (HOME is overridden below)
bench_db_up() {
  AX_DATA_DIR="$BENCH_DATA" AX_DB_PORT="$BENCH_PORT" bash scripts/db-start.sh
}
bench_db_reset() {            # wipe + restart for a COLD run
  [ -f "$BENCH_DATA/surreal.pid" ] && kill "$(cat "$BENCH_DATA/surreal.pid")" 2>/dev/null || true
  rm -rf "$BENCH_DATA/db"
  bench_db_up
}
```

Schema must be applied to the fresh bench DB before ingest (see `scripts/dev-db.sh` for the
bucket-path-rewrite + `surreal import` recipe; mirror it for the bench data dir).

### 1d. The ingest command under test

Always run ingest from source with the bench env, so input + output are both isolated:

```bash
bench_ingest() {  # $1 = optional --since / --stages overrides
  HOME="$BENCH_HOME" \
  AX_DATA_DIR="$BENCH_DATA" \
  AX_DB_URL="ws://127.0.0.1:$BENCH_PORT" \
  AX_PROGRESS=off \
  bun apps/axctl/src/cli/index.ts ingest "$@"
}
```

Pin a **fixed scope** for the whole mission (e.g. a full ingest of the frozen corpus, or a fixed
`--since`/`--stages` set). Decide it once, record it, never change it mid-mission - otherwise
numbers aren't comparable.

---

## 2. Benchmark harness (the measurement)

Build a small harness (`scripts/bench-ingest.ts` in the worktree) that produces a **structured
result per run**. It must:

1. **Cold run:** `bench_db_reset` → schema apply → time a full `bench_ingest` (empty DB → full graph).
2. **Warm run:** immediately re-run `bench_ingest` against the now-populated DB (exercises the
   idempotent re-ingest path; this is the common real-world case).
3. Repeat each ≥ 3× and report **median** (and min/max) - ingest has variance.
4. Capture **per-stage durations** from the trace: run one measured pass with `--debug` and parse the
   `SpanEnd` lines (`{"_tag":"SpanEnd","name":"<stage>","durationMs":...}`) from stderr into a
   per-stage breakdown. (Or extend instrumentation - see §4.)
5. Capture **total SurrealDB query count** and, if cheap, **peak RSS** (`/usr/bin/time -l`).
6. Emit one JSON object per run to `bench-results/<attempt-id>.json`:
   ```json
   { "attempt": "000", "git": "<sha>", "coldMedianMs": 0, "warmMedianMs": 0,
     "perStageMs": {"claude": 0, "codex": 0, ...}, "queries": 0, "rssMb": 0, "runs": [..] }
   ```

Keep the harness itself constant across attempts (don't optimize the harness, optimize ingest).

---

## 3. Baseline

Run the harness on **clean `main`** (no changes) and record `attempt 000 = baseline` in `ATTEMPTS.md`
and `bench-results/000.json`. Everything is measured as Δ vs this baseline. Re-confirm the baseline
once mid-mission (machine drift) and note any environmental variance.

---

## 4. Instrumentation (extend only if it pays for itself)

The pipeline already emits per-stage spans (`LiveTrace.step`, see `apps/axctl/src/ingest/stage/runner.ts`)
with `durationMs`, and now per-stage row counts (`attribute:ingest.records`). Use that first. Add finer
instrumentation **only when a stage is the bottleneck and you need to see inside it**, e.g.:

- Split a hot stage's span into sub-spans (parse vs transform vs DB-write).
- Count + time SurrealDB round-trips (wrap the `SurrealClient.query` in `packages/lib/src/db.ts` with a
  timing/counter behind an env flag - keep it off by default so it doesn't skew prod).
- Log batch sizes / statement counts per flush.

Instrumentation changes are themselves attempts (measure their overhead; they must be off or negligible
in the accepted path).

---

## 5. Iteration protocol (the ≥100 attempts)

For each attempt:

1. **Pick a target** from profiling (the current slowest stage / the biggest query count), not a hunch.
2. **State a hypothesis** in one line ("codex stage is DB-write-bound; batching N statements per query
   will cut round-trips").
3. **Make ONE change.**
4. **Benchmark** (cold + warm, median of ≥3) via the harness.
5. **Correctness gate** (§6). If it fails → reject, revert, log as failed.
6. **Compare:** Δ vs baseline, Δ vs best-so-far. Log to `ATTEMPTS.md` + `bench-results/NNN.json`.
7. **Keep or revert:** keep only if faster AND correct AND tests green; otherwise `git restore`/stash
   it away. Kept wins become a clean commit on the perf branch.
8. Re-profile and repeat. Stop early only if the §"Stop conditions" are met.

The loop must reach **≥ 100 logged attempts**. Failed/regressing attempts count - log them.

### Ledger format (`ATTEMPTS.md`, append-only table)

| # | sha | hypothesis | change (1 line) | cold ms (Δ%) | warm ms (Δ%) | bottleneck stage | correctness | tests | kept? |
|---|-----|-----------|-----------------|--------------|--------------|------------------|-------------|-------|-------|
| 000 | … | baseline | - | 0 (-) | 0 (-) | claude | ✓ ref | ✓ | n/a |
| 001 | … | … | … | … | … | … | ✓/✗ | ✓/✗ | ✓/✗ |

---

## 6. Correctness gate (every attempt)

A faster ingest that changes the graph is a **failure**. After each attempt's ingest, assert the output
equals baseline:

1. **Row counts per table** match the baseline (snapshot baseline counts once; diff each attempt).
   Query the bench DB for `SELECT count() FROM <table> GROUP ALL` across the key tables (session,
   turn, tool_call, agent_event, skill, signal, …) and compare.
2. **Key invariants** hold: re-ingest is idempotent (warm run doesn't throw / doesn't change counts),
   no orphaned edges, `agent_event_session_seq` unique index never violated.
3. **`bun run typecheck`** → 0 errors, **`bun test`** (at least the ingest suites) → 0 fail.
4. Spot-check a few representative records (a known session's turns) match baseline.

Automate 1–3 in the harness so the gate is cheap to run every attempt.

---

## 7. Optimization hypothesis backlog (seeds - profile to prioritize)

Grounded in the current code; treat as a starting menu, not a mandate. Measure each.

- **Pipeline concurrency:** `PIPELINE_CONCURRENCY = 2` (`runner.ts`) - try 3/4/CPU-bound; watch DB contention.
- **Per-stage internal concurrency:** claude=8, codex=4 - tune; find the DB saturation point.
- **DB round-trips / batching:** fewer, larger `query` calls; batch statements; `BEGIN/COMMIT` per session.
- **The new clear-before-insert DELETEs** (idempotency fix) - cost vs a diff-based "only delete what changed".
- **RocksDB tuning:** `AX_DB_ROCKSDB_BLOCK_CACHE_SIZE` / `WRITE_BUFFER_SIZE` / `MAX_WRITE_BUFFER_NUMBER`
  (`scripts/db-start.sh`) - bigger cache/buffers for write-heavy ingest.
- **TraceSink flush interval** (`flushIntervalMs: 200`) - irrelevant to data, but check overhead.
- **Parse cost:** JSON parsing of large transcripts; streaming vs buffering; skip unchanged files via mtime.
- **Index maintenance:** are any indexes redundant / could be deferred and built once at end?
- **Redundant work on warm re-ingest:** skip sessions whose source file is unchanged since last ingest.
- **String building:** the SQL statement construction (surrealObject/surrealString) hot paths.

---

## 8. Comparing agents (leaderboard)

If multiple agents/approaches run in parallel (each in its **own** worktree + **own** bench port + data
dir - never shared), each appends to a **shared leaderboard** keyed by approach. Compare on the SAME
frozen corpus + harness so numbers are commensurable. The leaderboard (`LEADERBOARD.md`) ranks confirmed
wins by cold + warm median; ties broken by correctness robustness + simplicity of the change. Cross-
pollinate: a winning idea from one agent becomes a hypothesis others can stack.

> Each parallel agent MUST use a distinct `BENCH_PORT` and `BENCH_DATA`/`BENCH_HOME` - no sharing, or
> the measurements (and the DBs) corrupt each other.

---

## 9. Stop conditions

Stop when ANY holds (and write `REPORT.md`):
- ≥ 100 attempts logged AND the last ~15 attempts yield < 1% improvement (diminishing returns), or
- a clear set of wins totals a meaningful speedup (e.g. ≥ 25–40% cold and/or warm) and further attempts
  stall, or
- the owner says stop.

Never stop with the bench DB/worktree left dirty in a way that implies a win that wasn't confirmed.

## 10. Deliverables (hand back)

- `ATTEMPTS.md` - full ledger (≥100 rows).
- `LEADERBOARD.md` - ranked confirmed wins (if multi-agent).
- `bench-results/*.json` - raw per-run data.
- `REPORT.md` - baseline, bottleneck map, what worked/didn't (with numbers), recommended merge set,
  any new instrumentation worth keeping.
- The winning changes as **clean, individually-reviewable commits** on `perf/ingest-speed`, each with
  its before/after numbers in the commit body. (Merging to `main` requires owner review.)

## Guardrails recap

- Isolated worktree + isolated bench DB (unique port/data dir) + frozen corpus. Never `:8521`/`:8522`,
  never the real `~/.claude`/`~/.codex` as the live target.
- Correctness gate every attempt; reject faster-but-wrong.
- One change per attempt; measure before/after; log everything.
- Don't optimize the harness; don't change the corpus or scope mid-mission.

## Reference (key files)

- Pipeline + concurrency: `apps/axctl/src/ingest/stage/runner.ts`
- Core ingest program: `apps/axctl/src/ingest/run.ts`
- Per-stage tracing / progress timing: `apps/axctl/src/cli/ingest-trace-progress.ts`, `packages/lib/src/live-traces/`
- DB client (query timing hook point): `packages/lib/src/db.ts`
- Provider-event writes (idempotent clear-before-insert): `apps/axctl/src/ingest/provider-events.ts`
- Disposable DB + RocksDB knobs: `scripts/db-start.sh`; dev-DB recipe: `scripts/dev-db.sh`
- Existing bench scaffolding: `scripts/bench-empty-db.sh`, `scripts/benchmark-turn-fts.ts`
- Transcript locator (corpus paths): `packages/lib/src/transcript-locator.ts`
