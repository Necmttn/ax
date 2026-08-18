# v3 — events + SQL models, built ON v2 (not a rewrite)

Status: PLAN. v2 (#849) merges to main untouched by this. Every phase ships
independently, is reversible, and gates on a measurement. Prototype:
session scratchpad `proto/` (329 loc, full-corpus runs cited below).

## Thesis

The self_ms instrument (#865/#866) proved an ingest run is ~100% database
time (628s of a 621s wall). ax is not a parser that uses a database; it is a
database whose input is JSONL. So: JS shrinks to parsers + scheduler; DuckDB
derives; events are the source of truth.

## Learnings this plan is built from (all measured, this week, this machine)

| learning | receipt |
| --- | --- |
| derives belong in the engine | self sum 628.1s ≈ run wall 621.3s (1.01x) |
| wall clock lies at concurrency >1 | stage sums 2.99–3.75x wall; serial exactly 1.00x (#841) |
| batch >> row-by-row | 633k rows loaded in 1.2s via read_ndjson vs per-row FFI |
| full pipeline potential | proto cold 14.4s vs v2 5,136s; warm no-op 0.2s vs 621s |
| judgment baked at ingest is expensive to fix | a classifier fix = re-ingest 5.6 GB; as SQL model = ~0.1s rebuild |
| rewrites re-earn old bugs | proto reproduced watermark + type-inference bug classes in 10 min |
| parsers are the crown jewels | claude parser 2,000 loc of harness knowledge vs proto's 60 |
| the shape is validated externally | alfredvc/cct converged on transcripts→DuckDB+skills independently |

## Non-goals

No engine change. No new daemon. Judgment sidecar untouched. CLI/MCP surface
stable. No parser rewrite ever — parsers migrate only behind golden-corpus
replay tests.

## Phases

### Phase 0 — safety + instruments (prereqs, partly landed)

- **#837 budget-at-seam FIRST** (active data loss: subagents stage output
  discarded every run at 0.0ms self time). Enforce derive cap on self_ms at
  the seam: refuse the next call when budget spent; typed error; stage
  settles clean. Wall-clock watchdog stays, demoted to `hung` detector.
- Golden corpus: one real (sanitized) transcript per provider committed as
  fixture + replay test asserting normalized row shapes. Replaces
  parity-by-grep as the parser contract. Blocks all later parser touches.
- Landed already: self_ms (#866), named skips (#863), AX_PIPELINE_CONCURRENCY (#864).
- Trio rides here: #869 COMMENT ON codegen (S, standalone).

### Phase 1 — driver swap (async under the same seam)

- Replace the synchronous bun:ffi internals of CacheRead/withCacheWrite with
  the threaded promise-based DuckDB client. Interface unchanged; callers
  untouched.
- SPIKE FIRST: napi module embeddability in the `bun build --compile` binary
  (same class of problem as the dylib embed). Spike outcome decides: full
  swap, or neo-on-source + FFI-on-binary (accepted complexity), or stop.
- Gates: full suite green; self attribution still ~1.0x; a timeout can now
  actually preempt a query (retire #837's cooperative workaround later).
- **DONE (#880).** Full swap shipped: `packages/lib/src/duckdb/binding.ts`
  stages `duckdb.node` next to ax's dylib (content-addressed dir, dylib
  symlinked) and loads `@duckdb/node-api` over it - require.cache seeding in
  source mode, a bundler shim reading `AX_NAPI_BINDING_GLOBAL` in the
  compiled binary (plugin in `scripts/build-axctl.ts`; `duckdb-embed.gen.ts`
  now also embeds the addon). `client.ts` rewritten on the napi promises
  behind the UNCHANGED exported surface; `ffi.ts` deleted. Gates measured:
  full suite green (only the pre-existing studio-desktop electron
  exemptions), CLI read wall 0.49-0.52s -> 0.52-0.57s (residual = node-api JS
  import + addon hash), and a 250ms `Effect.timeout` preempts a multi-second
  statement natively (pinned in client.test.ts). One engine per process: the
  addon is process-global, so a second dylib path is a typed refusal.
  self_ms semantics: per-call wall time now (upper bound under concurrent
  stages; exact when serialized) - self-time.ts documents it.

### Phase 2 — batch writers

- Provider stages write NDJSON spool → one `INSERT OR REPLACE ... FROM
  read_ndjson(..., columns=...)` per table. Explicit columns always
  (inference ban — proto bug). PK dedup replaces per-writer idempotency care.
- Trio rides here: #867 attribution fields (parser touch + 4 columns +
  `--reparse=claude`), done WITH the batch-writer touch to avoid re-touching.
- Gate: cold backfill wall time; expectation parse-bound (~minutes, not 85).

### Phase 3 — derives → SQL models, one at a time

- Model runner: `models/*.sql`, `-- inputs:` headers, topo-run inside DuckDB,
  registered as stages in the EXISTING StageRegistry (ledger, progress,
  budget unchanged).
- Port order by measured self_ms: turn-content-blocks (302.2s) →
  run-evidence (99.6s) → outcomes (53.6s) = 455s of 628s. Then opportunistic.
- Contract per port: old TS stage kept behind a flag one release; shadow-run
  both on the real store; row-for-row diff clean; then delete TS.
- A model without a watermark predicate must declare `full_rebuild` visibly.
- Trio rides here: #868 cache-bust lens ships as a model (corroborate vs raw
  cache-token deltas; proposal minting per open question below).

### Phase 4 — events as the contract

- Freeze `ev_*` tables as the normalized layer; segment export/import =
  remote/sandbox accumulation (parked idea lands free).
- BlobPointer branded type (pointer-vs-path compile error).
- Watermark keyed by content hash, not absolute path (merge-safe).

### Phase 5 — learning layer (gated prototype)

- Harvest free labels (landed/reverted/repair episodes/sidecar verdicts) →
  features model (SQL) → LLM-as-labeler for gaps (dojo surplus quota) →
  train tiny (logistic/GBT, CPU, seconds) → weights-as-table → inference as
  a SQL model in the DAG, versioned.
- Ship gate: beats the regex baseline (JUDGMENT_GUARD_RE first) on held-out
  labels, else the regex stays. Regexes become features, never deleted first.

## Sequencing + effort (rough)

0: #837 ~0.5d · golden corpus ~1d · #869 ~0.5d
1: spike ~0.5d, swap ~1–2d
2: ~1–2d + #867 ~0.5d (+ reparse run)
3: ~0.5–1d per stage ported, 3 stages to capture 72% of DB time · #868 ~1d
4: ~1–2d
5: prototype ~1d, then evidence decides

## Kill criteria

- Phase 1 spike fails binary embed AND dual-driver is judged too complex → stay FFI, Phases 2–3 still proceed (they help regardless).
- Any Phase 3 shadow diff not clean after 2 fix rounds → that stage stays TS, move on.
- Phase 5 model loses to regex → don't ship, keep labels accumulating.

## Unresolved questions

1. #868 proposals: **ANSWERED 2026-08-18 — auto-mint.** Mint is not apply
   (accept keeps the human gate), so the lens mints at ingest like retro
   clusters and churn hotspots, behind three guards: (a) corroboration — the
   lens dollar figure must agree within ±25% with an independent recompute
   from raw `cache_creation_input_tokens` deltas, else report-only with a
   loud flag (fails closed if the undocumented fields break upstream);
   (b) recurrence — same offender across ≥2 ingest windows; (c) materiality
   ≥ $5/week and ≤3 open cache-lens proposals at once. Minted cards carry
   provenance: origin, corroboration delta, coverage window, confidence.
   Recorded on #868.
2. Phase 1: is the napi client embeddable in the compiled binary?
   **ANSWERED 2026-08-19 — yes, spike passed on all three counts.**
   (a) `bun build --compile` embeds the napi `.node` addon NATIVELY (extracts
   to a temp file and dlopens it - no codegen needed for the addon itself);
   the only failure mode is its dependent `libduckdb.dylib`, and dlopen
   searches the extraction dir for it, so embedding the dylib as a
   `{ type: "file" }` asset and extracting it there BEFORE the import fixes
   it - the same extract-to-disk pattern as the existing FFI dylib embed.
   (b) The bundler needs the non-darwin `@duckdb/node-bindings-*` platform
   packages stubbed via an `onResolve` plugin (only the host platform's
   package is installed).
   (c) Decisive extra: the `.node` runs against AX'S OWN static-FTS ICU-less
   libduckdb v1.5.5 (46 MB) - verified with `PRAGMA create_fts_index` +
   `match_bm25` returning correct scores, no network - so the swap keeps the
   exact engine build ax ships today instead of the napi package's 117 MB
   dylib. Full swap under the unchanged CacheRead/withCacheWrite seam is GO;
   the dual-driver fallback is not needed.
3. Phase 4 content-hash watermark: migration cost over 4.7k existing rows —
   re-hash all on first run, or lazy per-touch?
4. Live progress granularity: when a derive runs inside one SQL statement,
   per-stage progress events collapse to start/end — acceptable, or does the
   Studio Live tab need statement-level progress?
5. Do v3 phases wait for #849 to merge, or land on the sweep branch too?
   (Trio: sweep, per decision 2026-08-18. Phases: default wait for #849
   unless told otherwise.)
