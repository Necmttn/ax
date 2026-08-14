# v2-duckdb fleet backlog - Architecture v2.1 build

Epic: `v2-duckdb`. Destination: ax runs fully on an embedded DuckDB cache + SQLite judgment
sidecar + spool files, zero required background processes, SurrealDB and all five LaunchAgents
deleted - shipped to main as ONE final PR.

## Run policy (locked by the operator, 2026-08-14)

- **Stacked PRs.** Integration branch `v2/duckdb` (off main). Every chunk branches off the
  CURRENT TIP of `v2/duckdb` (or a dependent chunk's branch) and PRs INTO `v2/duckdb`.
  The orchestrator squash-merges chunk PRs into the integration branch after the consensus gate.
  ONE final PR ships `v2/duckdb` → main at the end. No chunk ever targets main directly.
- **No backward compatibility.** No dual-write, no shadow-read, no SurrealDB export/migration
  tooling, no compat shims, no legacy config support. Existing installs start from scratch:
  transcripts re-ingest, OTLP history starts at the spool's birth, `ax doctor` prints one line
  telling users the old SurrealDB data dir is obsolete and safe to delete. Correctness is proven
  by tests + the bench regression gate, not by comparing against the old engine.
- Decisions of record: wayfinder map Necmttn/ax#755 (all closed decisions), spikes #756/#757,
  benchmark + targets #758, plan `~/.ax/reports/2026-08-14-ax-architecture-v2.1.html`.

## Repo gates (every chunk, concrete)

- `bun run typecheck` → 0 errors
- `bunx tsc --noEmit -p tsconfig.json` → 0 errors (catches *.test.ts type errors the root
  typecheck misses)
- `bun test <changed areas>` green; new behavior has tests at the real seam
- No `BRIEF.md`/`REPORT.md` in commits (`git add -A ':!BRIEF.md' ':!REPORT.md'`)

## Bench regression targets (from #758, measured on real data)

Full re-derive write path <15s · FTS rebuild <30s · snapshot copy <5s · recall <150ms ·
aggregates <200ms · traversals <50ms · cache file <1GB. Fixture: 524MB JSONL export
(kept OUT of git; regenerate with `scripts/bench/` exporters).

## Wave graph

### Wave 0 - foundations (all independent, spawn in parallel)

- **w0-prunes** [lane: mechanical/codex] - Stop writing `agent_event.raw` at ingest; blob-bucket
  GC; 30-day retention pass for `otel_*` rows. Three independent prunes, small diffs each.
  Acceptance: ingest runs clean; a re-ingested session writes no `raw`; GC covered by a test.
- **w0-ffi-client** [lane: judgment/opus] - `@ax/lib/duckdb`: typed DuckDB client over `bun:ffi`
  + libduckdb. Start from `scripts/duckdb-spike/ffi/*` (WORKING spike code: by-value u64 handle
  gotcha solved there). Deliver: open (rw + read_only), query with typed row decode, close;
  `$bunfs` extract-to-content-hash-path (reuse-if-present); ingest lockfile (`~/.ax/ingest.lock`,
  fail-fast + `--wait`); snapshot publisher (`COPY FROM DATABASE` → tmp → atomic rename) and
  snapshot opener. Effect-native service (consult effect-solutions first), layer-testable.
  Acceptance: unit + e2e tests against a real temp DB; lock contention test; snapshot
  atomic-rename test (reader on old inode survives - pattern proven in #758).
- **w0-schema-ddl** [lane: judgment/opus] - DuckDB relational DDL replacing `schema.surql`:
  every current table; edge tables become plain `(in_id, out_id, …)` tables with indexes; FTS
  index plan (turn.text_excerpt, commit.message; skills search via plain SQL - ngram index
  deliberately dropped per #758). Deterministic content-hash ID contract (`packages/lib`):
  IDs = hash of natural key, NEVER autoincrement/run-timestamp; property test = two derives of
  the same fixture produce byte-identical IDs; dangling-sidecar-ref integrity check function.
  Acceptance: DDL file + id module + property tests green.
- **w0-otlp-spool** [lane: mechanical/codex] - `ax otlpd`: subcommand binding 127.0.0.1:1738,
  POST /v1/{metrics,traces,logs} → append raw body + received_at JSONL to
  `~/.ax/otlp/spool/YYYY-MM-DD.jsonl`, always-2xx, no DB handle, 90-day rotation (decision #760).
  New `otel-spool` ingest stage: tail spool files with per-file watermarks (mirror the JSONL
  provider work-unit pattern), decode with the EXISTING Effect schemas in `apps/axctl/src/otel/`,
  write through the current write path. Consent-gated LaunchAgent unit `com.necmttn.ax-otlpd`
  wired in install (recommended-on prompt per decision #759) - installed ONLY on consent.
  Acceptance: receiver e2e (POST → spool line), stage e2e (spool → rows), rotation test,
  malformed body still spooled.
- **w0-dylib-ci** [lane: mechanical/codex] - `scripts/build-duckdb.sh` from the PROVEN recipe
  (see `scripts/duckdb-spike/static-build/extension_config_local.cmake` + #757 resolution:
  v1.5.5, `GEN=ninja CORE_EXTENSIONS='json' EXTENSION_STATIC_BUILD=1 make`, fts via local
  config with `INCLUDE_DIR extension/fts/include`) + GH Actions workflow building
  macOS-arm64 + linux-{arm64,amd64} (`STATIC_LIBCPP=1` on linux) dylibs as release artifacts +
  air-gap smoke (`LOAD fts` + match_bm25 with autoinstall/autoload off). Embed codegen for the
  compiled binary mirrors `scripts/gen-studio-embed.ts` (build → `{type:"file"}` import →
  restore stub).
  Acceptance: local script produces a dylib that passes the air-gap smoke; workflow YAML lints.
- **w0-bench-ci** [lane: mechanical/codex] - Promote `scripts/bench/` (already copied) into a
  runnable suite: `bun scripts/bench/run.ts` loads the fixture (path via `AX_BENCH_FIXTURE`,
  absent → skip with notice), runs load/FTS/snapshot/query timings, exits non-zero when a
  target regresses (<15s re-derive etc. - table above). CI job wired but fixture-gated.
  Acceptance: suite runs against a mini fixture checked in for CI (generate a ~5k-row slice,
  <5MB, from the exporter scripts against synthetic rows - mini fixture tests the HARNESS,
  the real fixture tests the numbers).

### Wave 1 - the load-bearing seam (after w0-ffi-client + w0-schema-ddl merge)

- **w1-seam-design** [lane: judgment/opus; hold lifted by operator 2026-08-14 - auto-merge on passing gate] - The typed query seam every
  reader/writer goes through: define the seam API (reads open the snapshot; writes only inside
  ingest under the lock), port ONE representative vertical (e.g. `queries/recall.ts` +
  its CLI command) end-to-end as the template, and produce the PARTITION LIST of the ~168
  bypassing files into 3-5 mechanical port chunks (this list DEFINES wave 2 - write it into
  this backlog file as part of the chunk).
  Acceptance: seam module + one working vertical on DuckDB + partition list committed.

### Wave 2 - seam ports (FOG until w1 emits the partition list)

Parallel mechanical chunks (codex + grok lanes), one per partition: ingest writers · queries ·
dashboard routes · mcp/cli surfaces. Each: port files to the seam, tests at the real seam,
no behavior change beyond engine.

### Wave 3 - cut-over (FOG in detail; known shapes)

- c-ingest-cutover: ingest finish = FTS rebuild + snapshot publish; delete SurrealDB writes.
- c-sidecar-sqlite: judgment tables (proposal, verdicts, role tags/weights, retro,
  skill_triage_decision, transcript_label_review, dogfood_run, spar labels) → SQLite sidecar.
- c-daemon-subtraction: install.ts drops all 5 LaunchAgents (+ ax-otlpd stays, consent-gated);
  piggyback freshness drive (stale-cache check + debounced background ingest on CLI use);
  doctor rewrite (incl. the one-line "old SurrealDB dir obsolete" note).
- c-studio-ephemeral: `ax studio` ephemeral same-origin server over the snapshot; serve/pidfile/
  arbitration deletion.
- c-binary-embed: compile pipeline embeds the custom dylib; binary e2e smoke.
- c-surreal-delete: remove @ax/lib surreal client, schema.surql, self-heal, all dead code.

### Wave 4 - ship

- w4-ship: full-repo sweep (typecheck, all tests, bench gate on real fixture, docs/CLAUDE.md
  rewrite for the new architecture), then the SINGLE PR `v2/duckdb` → main with the complete
  story + deferred-concerns list.

## Chunk → branch convention

Branch `feat/v2-<chunk-id>` off `v2/duckdb` tip; PR base = `v2/duckdb`; squash-merge by the
orchestrator after the cross-model consensus gate. Rebase onto the integration tip before merge
when it moved.
