# Full Turn Text FTS Benchmark

Date: 2026-05-30

Question: what happens if `ax` builds full-text search on full `turn.text`
instead of only the 500-char `turn.text_excerpt`, and which query shape should
power cost attribution?

## Method

Script:

```sh
bun scripts/experiment-turn-fts.ts --days=30 --iterations=3 --limit=20 --terms='live trace,livetrace,live-traces' --scan
```

The experiment does not mutate the production `turn` schema. It creates a
temporary table from recent turns, builds the same analyzer/index shape on
`text_excerpt` and `text`, runs benchmark queries, and removes the table.

Measured query shapes:

- `bench.search.excerpt_fts`: FTS on 500-char `text_excerpt`.
- `bench.search.full_fts`: FTS on full `text`.
- `bench.search.full_scan_contains`: unindexed substring scan on full `text`.
- `bench.cost.subquery.*`: current production-style shape, where
  `session_token_usage` filters through `session IN (SELECT ... FROM turn ...)`.
- `bench.cost.two_step.*`: optimized shape: first fetch matching session refs,
  then query `session_token_usage WHERE session IN [refs]`.

## Current 30-Day Baseline

Earlier live-table benchmark on the current production `turn_text_fts` index:

- 30-day graph: 369,132 turns, 4,773 sessions.
- `turn.search.excerpt_fts`: median 5.9ms.
- `costs.for.excerpt_fts`: median 9.2s.
- `turn.search.full_scan_contains`: median 1.28s.
- Real CLI timing:

```sh
time bun src/cli/index.ts costs for --terms 'live trace,livetrace,live-traces' --since=30 --limit=20 --json
```

Result: 14.885s total.

Interpretation: the current FTS lookup itself is workable. The slow path is the
cost query that embeds the FTS lookup as a subquery and then sorts/join-filters
`session_token_usage`.

## Scale Sweep

### 10k Turns

Indexed chars: excerpt 342,242; full 2,058,088; full is 6.0x larger.

| Phase | Time |
| --- | ---: |
| copy turns | 248.0ms |
| index session | 79.0ms |
| index ts | 79.2ms |
| index excerpt FTS | 1.44s |
| index full text FTS | 2.61s |

| Query | Rows | Median |
| --- | ---: | ---: |
| search excerpt FTS | 3 | 0.9ms |
| search full FTS | 3 | 1.2ms |
| full scan contains | 3 | 24.7ms |
| cost subquery excerpt FTS | 3 | 1.80s |
| cost subquery full FTS | 3 | 1.58s |
| cost two-step excerpt FTS | 3 | 0.8ms |
| cost two-step full FTS | 3 | 0.6ms |

### 25k Turns

Indexed chars: excerpt 852,048; full 4,477,084; full is 5.3x larger.

| Phase | Time |
| --- | ---: |
| copy turns | 719.6ms |
| index session | 174.2ms |
| index ts | 183.5ms |
| index excerpt FTS | 3.32s |
| index full text FTS | 5.35s |

| Query | Rows | Median |
| --- | ---: | ---: |
| search excerpt FTS | 12 | 1.6ms |
| search full FTS | 14 | 1.8ms |
| full scan contains | 13 | 62.3ms |
| cost subquery excerpt FTS | 12 | 3.76s |
| cost subquery full FTS | 14 | 6.40s |
| cost two-step excerpt FTS | 12 | 0.9ms |
| cost two-step full FTS | 14 | 0.8ms |

Recall delta at 25k:

- excerpt FTS sessions: 12.
- full FTS sessions: 14.
- full FTS only: 2.
- excerpt-only vs full FTS: 0.
- full scan sessions: 13.

## Failure Threshold

The full 30-day isolated run copied all 369k turns and built scalar indexes, but
the FTS index build did not complete cleanly on the local SurrealDB/RocksDB
store. Attempts either stalled metadata queries or failed with:

```text
Transaction conflict ... MemTable only contains changes newer than SequenceNumber ...
Increasing max_write_buffer_size_to_maintain could reduce the frequency ...
This transaction can be retried
```

A 50k-turn run built excerpt FTS in 6.56s, then full-text FTS failed with the
same transaction-conflict class.

This means "just add a full-text index on production `turn.text`" is not an
operationally safe migration on the current local DB settings.

## Conclusions

1. Full-text FTS query latency is fine once the index exists. At 25k turns,
   excerpt FTS and full FTS are both under 2ms for search.
2. Full-text indexing is materially heavier. In the samples, full text indexed
   5-6x more characters and took about 1.6-1.8x the excerpt FTS build time.
3. Full scan is not a product path. It is already 62ms at 25k turns and was
   1.28s on the live 30-day table for search-only; full-scan cost queries can
   exceed a minute.
4. The largest performance bug is query shape, not excerpt vs full. The
   production-style subquery costs seconds, while the two-step `session IN [...]`
   cost query is around 1ms in the same experiment.
5. Recall does improve with full text. At 25k turns, full FTS found 2 additional
   sessions for the LiveTrace terms.

## Recommendation

Do not replace `turn_text_fts` with a production full-text index on `turn.text`
yet.

Ship the query-shape optimization first:

1. Fetch candidate session refs from the current FTS index.
2. Query `session_token_usage` directly with `session IN [refs]`.
3. Keep `--limit` bounded.

Then add full-turn search as a separate search table or staged migration:

- Store `session`, `ts`, `source`, `text`, and optionally a normalized/searchable
  chunk field.
- Build/rebuild the index outside the hot `turn` table path.
- Consider chunking long turns instead of indexing one large `text` field.
- Tune SurrealDB/RocksDB settings or build in batches before enabling full
  30-day indexing by default.
