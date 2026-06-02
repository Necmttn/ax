# Ingest-speed attempt ledger

Corpus: frozen subset ~98M at `$HOME/.cache/ax-bench/home`. Bench DB: disposable SurrealDB :8531.
Harness: `~/.cache/ax-bench/bench-run.sh <runs> <out>`. Golden (correctness ref): `~/.cache/ax-bench/golden.json`.
Times are wall-clock seconds per ingest; **cold** = 1st (empty→full), **warm** = last (steady-state re-ingest).

| # | change | cold s | warm s (Δ vs base) | gate | kept? | notes |
|---|--------|--------|--------------------|------|-------|-------|
| 000 | baseline (untouched main) | 33 | 49 | ref | n/a | warm > cold; re-derive-everything is the cost |
| 001 | turn-content-blocks incremental via `NOT IN` | 32 | 138 (**+182%**) | FAIL | ✗ revert | unindexed `NOT IN` membership is O(n·m); also under-derived on cold. Lesson: skip-check must be indexed/hash-based |
| 002 | turn-content-blocks incremental via content_hash Map | 24 | 27 (**-46%**) | PASS | ✓ keep | indexed `content_document_source` lookup → JS `Map<source_ref,content_hash>`; UPSERT only new/changed hashes (deterministic ids ⇒ in-place), no blanket DELETE; `AX_REDERIVE_CONTENT=1` forces full. Counts exact-match golden; converges over the 3 runs as the bench expects |
| 003 | turn-analysis incremental via analyzed-turn Set | 26 | 24 (**-11% vs 27**) | PASS | ✓ keep | turns are append-only ⇒ an existing `turn_analysis` row is output-equivalent. Load analyzed turn keys in ONE indexed read (`SELECT turn FROM turn_analysis`, UNIQUE `turn_analysis_turn` index) → JS `Set`; still derive over the full ordered row set (reacts_to lookahead needs session context) but persist only turns not yet analyzed; dropped the blanket `DELETE reacts_to/expresses/turn_analysis/semantic_signal`. `AX_REDERIVE_ANALYSIS=1` forces full reset+re-derive. Verified output-equivalent: incremental 3-run bench → turn_analysis 15201, semantic_signal 21, expresses 438, reacts_to 45; a forced full re-derive on the same DB produced the identical 15201/21/438/45. All golden `.counts` exact-match |

<!-- append one row per attempt below; keep newest at bottom -->
