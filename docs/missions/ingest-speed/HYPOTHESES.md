# Ingest-speed hypothesis queue (work top-down; skip if superseded)

Profile (warm, concurrency=2): turn-content-blocks 30s · claude 19s · git 17s · turn-analysis 9s · rest small.
Each attempt = ONE change, benchmarked via `~/.cache/ax-bench/bench-run.sh <runs> <out.json>`, gated against `~/.cache/ax-bench/golden.json` counts, kept (commit on perf/ingest-speed) or reverted.

Status legend: `[ ]` todo · `[x]` done (see ATTEMPTS.md) · `[~]` superseded.

- [ ] **002 - turn-content-blocks incremental via content_hash Map.** Load existing `(turn → content_hash)` in ONE query (`SELECT source, content_hash FROM content_document WHERE source_kind='turn'`) into a JS Map; build/UPSERT only turns whose `stableDigest(text)` is new/changed; drop the blanket DELETE. NO `NOT IN` (attempt 001 proved it's unindexed + 3× slower). File: `apps/axctl/src/ingest/turn-content-blocks.ts`. Escape hatch: `AX_REDERIVE_CONTENT=1` forces full. Expected: kills the 30s on warm.
- [ ] **003 - turn-analysis incremental.** Same hash/marker pattern as 002 once it works. File: `apps/axctl/src/ingest/turn-analysis.ts`.
- [ ] **004 - PIPELINE_CONCURRENCY 2 → 4.** One-line (`apps/axctl/src/ingest/stage/runner.ts`). Pure measurement; watch DB contention (may regress). Try 3 and 4.
- [ ] **005 - executeStatements chunkSize 250 → 1000.** Fewer DB round-trips. Find where chunkSize is passed (`@ax/lib/shared/statement-exec` callers); bump for the hot stages. Measure.
- [ ] **006 - claude skip-unchanged source files.** Track per-file `(path, mtime, size)` watermark in a small table; skip parsing files unchanged since last ingest. File: `apps/axctl/src/ingest/transcripts.ts`. Big real-world win (watcher re-ingests constantly).
- [ ] **007 - git stage skip-unchanged.** Re-walks history every run (17s). Cache last-ingested HEAD sha per repo; only walk new commits. File: `apps/axctl/src/ingest/git.ts`.
- [ ] **008 - RocksDB cache/write-buffer bump.** `AX_DB_ROCKSDB_BLOCK_CACHE_SIZE` etc (in `scripts/db-start.sh`). Constant across attempts once chosen. Measure write-heavy ingest gain.
- [ ] **009 - subagents/outcomes/closure/pricing** (~4s each) incremental, if still material after the big wins.
- [ ] **010+ - re-profile** after each kept win; chase the new top stage. Add hypotheses as the bottleneck map shifts.

## Rules (every attempt)
- ONE change. Gate: all `golden.json` counts must match (output-equivalent) AND `bun run typecheck` clean AND the touched stage's unit test green. Faster-but-wrong = revert.
- Keep = commit on `perf/ingest-speed` with before/after in the message. Revert = `git restore`.
- Log: append a row to ATTEMPTS.md + write `bench-results/NNN.json`. Persist everything (resumable).
- Never touch :8521/:8522 or real `~/.claude`/`~/.codex` as a write target. One ingest at a time.
