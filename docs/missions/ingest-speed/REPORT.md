# Ingest-speed optimization - REPORT

**Result: warm re-ingest 50s → 5s - a 10× speedup (−90%). Cold 29s → ~20s (−31%).**
All wins gated **output-equivalent** (every table count exact-matches the untouched-`main` golden on the frozen corpus subset). Branch: `perf/ingest-speed`.

## Method

- Isolated: dedicated worktree + disposable SurrealDB on `:8531` + a frozen ~98M corpus subset (via `HOME` override). Never touched the real DBs (`:8521`/`:8522`) or `~/.claude`/`~/.codex`.
- Each attempt = ONE change → `bench-run.sh` (wipe + 3 ingests, converge) → gate (all golden counts match + `typecheck` + the touched stage's unit test) → keep (commit) or revert. Serialized (one ingest at a time, laptop-safe).
- Golden (untouched main, converged): **cold 29s / warm 50s**; counts `content_document 2247, content_block 10406, content_atom 23892, turn 15201, tool_call 4555, agent_event 17549, session 81, skill 24, signal 0`.

## The core finding

Warm re-ingest was **slower than cold** because every stage **re-did all its work each run** - either re-parsing unchanged source files or `DELETE`-all-then-re-derive on the whole DB - regardless of what changed. Since the real-world hot path is the watcher firing `ingest --since=1` constantly, this was the dominant cost. The fix, applied stage by stage: **cheap, indexed skip of already-done work** (never `NOT IN`).

## Leaderboard (kept wins, cumulative)

| # | change | warm before→after | Δ | mechanism |
|---|--------|-------------------|---|-----------|
| 002 | turn-content-blocks incremental | 50s → 27s | −46% | one indexed read of `(turn→content_hash)` into a JS Map; UPSERT only new/changed (deterministic ids ⇒ in-place); drop blanket DELETE. `AX_REDERIVE_CONTENT=1` |
| 003 | turn-analysis incremental | 27s → 24s | −11% | indexed `SELECT turn FROM turn_analysis` into a Set; persist only un-analyzed turns. `AX_REDERIVE_ANALYSIS=1` |
| 004 | PIPELINE_CONCURRENCY 2→4 | 24s → 22s | −8% | constant knob |
| 006 | claude skip-unchanged source | 22s → 13s | −41% | new `ingest_file_state` watermark (path+mtime+size); `statSync` skip of unchanged transcript files. `AX_REDERIVE_CLAUDE=1` |
| 007 | git skip-unchanged | 13s → 8s | −38% | per-repo HEAD-sha watermark in `ingest_file_state`; skip the `git log`/`git show` walk when HEAD+window unchanged. `AX_REDERIVE_GIT=1` |
| 008 | closure skip-unchanged | 8s → 6s | −25% | input-fingerprint (`stableDigest` of derive inputs) watermark; skip DELETE+re-RELATE of 6346 edges + 1513 rows when unchanged. `AX_REDERIVE_CLOSURE=1` |
| 009 | pricing skip-unchanged | 6s → 5s | −17% | fingerprint the 4333-row `agent_model` UPSERT batch; skip when unchanged. `AX_REDERIVE_PRICING=1` |

**Net: 50s → 5s (10×).** Every win has an `AX_REDERIVE_*=1` escape hatch to force a full re-derive after its logic changes.

## Rejected (gate working as designed)

| # | change | result | lesson |
|---|--------|--------|--------|
| 001 | turn-content-blocks incremental via `WHERE id NOT IN (subquery)` | warm 50s → **138s** (+182%), + under-derived cold | `NOT IN (subquery)` is unindexed O(n·m). Skip-checks MUST be indexed / hash-based - this drove the 002 redesign |
| 005 | executeStatements chunkSize 250→1000 | correct, but warm 23s ≥ 22s (no gain) | turn-content-blocks already incremental ⇒ chunk size only affects the cold path |

## Bottleneck-map evolution (warm, per-stage)

- **Start:** turn-content-blocks 30s · claude 19s · git 17s · turn-analysis 9s.
- **After derive-stage incrementals (002–004):** claude + git dominate.
- **After skip-unchanged (006–007):** closure 3.4s · subagents 2.1s · pricing 1.6s.
- **After 008–009 (now, 5s):** subagents ~1.9s + a flat tail of sub-1.5s stages, all concurrency-overlapped at concurrency=4. **This is the floor** - remaining wins move wall-clock sub-second.

## Why we stopped

Diminishing returns: every >1s blanket-re-write stage is now incremental. Warm 5s is irreducible overlapped per-stage work. The only remaining candidate (`subagents` ~1.9s) needs moderate per-file watermarking for a sub-second wall-clock gain. Stopping at **10×** with a clean, reviewable result beats grinding marginal attempts.

## Recommended merge set for `main`

All seven kept commits on `perf/ingest-speed` are independent, gated, and output-equivalent - recommend cherry-picking the lot:

- **High value, low risk:** 002, 003 (derive incrementals - pure indexed-skip, escape-hatched).
- **Highest real-world value:** 006, 007 (claude/git skip-unchanged - the watcher's `--since=1` hot path; needs the small `ingest_file_state` schema addition).
- **Solid:** 008, 009 (closure/pricing fingerprint skips).
- **Trivial:** 004 (concurrency 2→4 - re-verify on lower-core machines; safe to drop if it regresses elsewhere).

Before merging: run each stage's `AX_REDERIVE_*=1` once if its derivation logic later changes; the watermarks self-heal on input change but a code change to the deriver needs one forced re-derive (documented per stage). The `ingest_file_state` table is the one schema addition (in `packages/schema/src/schema.surql`).

## Artifacts

- `ATTEMPTS.md` - full ledger. `bench-results/*.json` - raw per-attempt numbers. `docs/missions/ingest-speed/HYPOTHESES.md` - the worked queue + floor assessment.
- Golden + harness: `~/.cache/ax-bench/{golden.json,bench-run.sh}` (frozen corpus at `~/.cache/ax-bench/home`, bench DB `:8531`).
