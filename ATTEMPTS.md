# Ingest-speed attempt ledger

Corpus: frozen subset ~98M at `$HOME/.cache/ax-bench/home`. Bench DB: disposable SurrealDB :8531.
Harness: `~/.cache/ax-bench/bench-run.sh <runs> <out>`. Golden (correctness ref): `~/.cache/ax-bench/golden.json`.
Times are wall-clock seconds per ingest; **cold** = 1st (empty→full), **warm** = last (steady-state re-ingest).

| # | change | cold s | warm s (Δ vs base) | gate | kept? | notes |
|---|--------|--------|--------------------|------|-------|-------|
| 000 | baseline (untouched main) | 33 | 49 | ref | n/a | warm > cold; re-derive-everything is the cost |
| 001 | turn-content-blocks incremental via `NOT IN` | 32 | 138 (**+182%**) | FAIL | ✗ revert | unindexed `NOT IN` membership is O(n·m); also under-derived on cold. Lesson: skip-check must be indexed/hash-based |

<!-- append one row per attempt below; keep newest at bottom -->
