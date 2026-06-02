# Ingest-speed attempt ledger

Corpus: frozen subset ~98M at `$HOME/.cache/ax-bench/home`. Bench DB: disposable SurrealDB :8531.
Harness: `~/.cache/ax-bench/bench-run.sh <runs> <out>`. Golden (correctness ref): `~/.cache/ax-bench/golden.json`.
Times are wall-clock seconds per ingest; **cold** = 1st (empty→full), **warm** = last (steady-state re-ingest).

| # | change | cold s | warm s (Δ vs base) | gate | kept? | notes |
|---|--------|--------|--------------------|------|-------|-------|
| 000 | baseline (untouched main) | 33 | 49 | ref | n/a | warm > cold; re-derive-everything is the cost |
| 001 | turn-content-blocks incremental via `NOT IN` | 32 | 138 (**+182%**) | FAIL | ✗ revert | unindexed `NOT IN` membership is O(n·m); also under-derived on cold. Lesson: skip-check must be indexed/hash-based |
| 002 | turn-content-blocks incremental via content_hash Map | 24 | 27 (**-46%**) | PASS | ✓ keep | indexed `content_document_source` lookup → JS `Map<source_ref,content_hash>`; UPSERT only new/changed hashes (deterministic ids ⇒ in-place), no blanket DELETE; `AX_REDERIVE_CONTENT=1` forces full. Counts exact-match golden; converges over the 3 runs as the bench expects |

<!-- append one row per attempt below; keep newest at bottom -->
