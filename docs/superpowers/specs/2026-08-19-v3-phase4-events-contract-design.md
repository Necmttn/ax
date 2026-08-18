# v3 Phase 4 - events as the contract (#893)

Status: DRAFT, revised after adversarial review (round 1, 2026-08-19: 1
blocker + 9 major findings, all incorporated below - the findings are cited
inline as `[R#n]`). Parent plan:
`docs/superpowers/plans/2026-08-18-v3-events-and-sql-models-plan.md` (Phase 4).
The BlobPointer slice already shipped (#891). This spec covers the remaining
three coupled pieces: the event-layer freeze, segment export/import, and the
content-hash watermark.

## Thesis, restated for Phase 4

The v3 plan's thesis is "JS shrinks to parsers + scheduler; DuckDB derives;
events are the source of truth." Phases 1–3 delivered the machinery (napi
driver, NDJSON spool, SQL models). Phase 4 writes the CONTRACT down: which
tables ARE the events, what a parser may write, what a derive may write, and
what it means to move a slice of the store between machines.

The prototype validated the shape with three literal `ev_*` tables. v2's real
event layer already exists and is far richer - the normalized tables
(`session`/`turn`/`tool_call`/edges), the provider event tables (`agent_*`),
usage (`turn_token_usage`/`session_token_usage`), and the structural
side-tables (`compaction`, `plan*`, hook tables, `otel_*`). We do NOT rename
anything to `ev_*`; we classify what exists and freeze the boundary.

## Piece 1 - the event-layer freeze

### The classification

Every DuckDB cache table gets a `layer` in its manifest entry
(`packages/schema/src/duckdb-tables.ts` `TABLE_METADATA` - which already
throws at import when the DDL and the manifest disagree, so a new table
cannot ship unclassified; a required `layer` field is enforced by the type):

- **`event`** - written from OUTSIDE-WORLD bytes: transcripts, git, the
  skills catalog, the OTLP spool, the advice ledger, hook configs. The
  source of truth. NOTE the definition is "written from outside bytes", NOT
  "rebuildable by re-reading the world": two loaders CONSUME their source
  (the usage stage truncates its log at drain; the otel spool rotates at 90
  days), so for those tables the cache row is the only durable copy [R#3].
  That makes them MORE event-like, not less - they can never be re-derived,
  so segments (piece 2) are their only portability story.
- **`derived`** - written by a derive from event-layer rows, rebuildable
  from the event layer ALONE with no disk access: `run_evidence_*`,
  `cache_bust_event`, `command_outcome`, `session_health`, metrics/signals,
  `directive_ngram`, `has_content`, `loaded`, `produced`, `telemetry_of`, ...
- **`bookkeeping`** - the store's own state: `ingest_file_state`,
  `schema_comment_state`, `ingest_stage`, `ingest_run`, `ingest_event` [R#5].

### The stage TAG is not the layer authority [R#2, R#3]

The review killed the draft's assumption that `tags: ["ingest"|"derive"]`
maps onto the layer boundary. Counterexamples, all real today:

- the `subagents` stage is tagged `derive` but IS A PARSER - it walks
  `~/.claude/projects/*/<id>/subagents/agent-*.jsonl` with a `fileWatermark`
  and writes `session` rows (the flagship event table);
- `advice` and `usage` are tagged `derive` but are external-ledger LOADERS
  (event writes by this spec's definition);
- `spawned` has BOTH a parser writer (subagents stage) and a derive writer
  (`derive-spawned.ts`) - no single-writer assumption survives;
- the `git` stage is tagged `ingest` but draws `produced` correlation edges
  (a derived table) and UPDATEs `session.repository`/`session.checkout`;
- `invoked-positions` (tagged `derive`) UPDATEs `invoked`, a parser-written
  table, stamping derived `turn_index`/`total_turns` columns onto it.

So the contract binds WRITES, not tags. Two additions:

1. Each `StageDef` (and each non-stage writer - see below) declares
   `writes: readonly TableWrite[]`, where a `TableWrite` is
   `{ table, mode: "parse" | "enrich" | "derive" }`.
   - `parse`: inserting event rows from outside bytes. Legal only on
     `event` tables.
   - `derive`: writing `derived` tables. Legal only there.
   - `enrich`: UPDATE-ing an ENUMERATED set of enrichment columns on an
     event table (`session.repository`, `session.checkout`,
     `session.reasoning_effort`, `invoked.turn_index`,
     `invoked.total_turns`, ...). This legalizes today's cross-writes
     EXPLICITLY instead of pretending they do not exist [R#3]. The
     enumerated column list lives next to `TABLE_METADATA`, pinned by test.
2. The "wipe derived is safe" guarantee is scoped honestly: wiping every
   `derived` TABLE is always safe; enrichment COLUMNS on event tables
   re-fill on the next enrichment pass (they are derived data at rest in an
   event row - a known, named exception, not smuggling).

### Enforcement

- (a) Static: a test walks every declared `TableWrite` and asserts
  `mode`-vs-`layer` legality (phrased over the write declarations, never
  over the ingest/derive member of the tags array [R#14]).
- (b) Behavioral: a fixture test runs each stage and diffs per-table CONTENT
  digests (e.g. `SELECT count(*), coalesce(bit_xor(hash(id)),0) FROM t` per
  table) before/after, catching UNDECLARED writes - row-count diffs are not
  enough because today's known violations are UPDATEs, which change no
  count [R#4].
- (c) Non-stage writers are covered by the same declaration, registered in a
  module-level list: `correlateOrphanOtel` (writes `telemetry_of` from
  `run.ts`, outside any StageDef) and the run/work-unit bookkeeping writers
  (`ingest_run`, `ingest_event`) [R#5].

No hot-path cost; everything is test-time.

## Piece 2 - segment export/import

The parked "remote/sandbox accumulation" idea: run ax in a sandbox or on a
second machine, carry the events home, merge. With the freeze in place a
segment is "session-scoped event rows, minus machine-local enrichment".

### What a segment carries [R#8, R#9]

- **Session-scoped event tables only**: `session`, `turn`, `tool_call`, the
  read/searched/edited/invoked edges, `agent_*` provider events,
  `turn_token_usage`, `session_token_usage`, `compaction`, `plan*`, hook
  tables - every event table with a session scope, filtered
  `WHERE session IN (...)` (per-table predicate column named in the
  implementing slice's manifest).
- **Enrichment columns are STRIPPED at export** (nulled in the projection):
  `session.repository`/`session.checkout` reference path-keyed checkout
  rows that are meaningless off-machine; `session.reasoning_effort` is
  local-config state. The importer's own enrichment passes re-fill them.
  This is what makes the convergence claim below true [R#9].
- **Dimension/catalog tables are NOT exported**: `skill`, `tool`, `file`,
  `commit`, `repository`, `checkout`, `agent_model`, `agent_provider`.
  Rationale per table class: catalogs are per-machine installs with
  write-stamped columns (`WRITE_STAMPED_COLUMNS` - `skill.ingested_at`,
  `skill_revision.ts`, `agent_def.ingested_at` - are stamped
  `CURRENT_TIMESTAMP` on EVERY upsert, so re-importing them is never a
  no-op and corrupts drift timestamps [R#9]); git objects re-ingest from
  the target's own clone. Imported edges into absent dimensions DANGLE by
  design (skill ids are stable name-derived, so they knit once the target
  installs the skill; a dangling edge is already a state the deref-free
  queries tolerate). Documented, not hidden.
- **Cost columns ride as-is** with a manifest note: `estimated_*` on usage
  tables were priced by the EXPORTING machine's catalog; acceptable
  divergence, same as local history priced before a catalog update [R#9].
- **Blobs and the sidecar do not ride** - `raw_file` pointers import as-is
  and simply do not resolve until/unless blobs move separately (#891 made
  pointer resolution a clean fallback rather than a lie); sidecar decisions
  are not events.

### Format

```
manifest.json      # below
<table>.ndjson     # one per exported table
```

`manifest.json` carries `segment_version`, `created_at`, `ax_version`,
`ddl_hash`, `scope`, and PER TABLE: row count, sha256 of the file, and the
**exported column list** - the import-side intersection loader needs it and
cannot infer it from bytes [R#6]. Optionally per-source-file content hashes
(`sha256`) for the watermark handshake (piece 3).

### Semantics

- **Export**: `ax segment export --sessions=<ids>|--since=Nd --out=<dir>`
  via `COPY (SELECT <explicit cols> ...) TO '<t>.ndjson' (FORMAT JSON,
  ARRAY false)`, manifest written LAST (a manifest-less dir is an aborted
  export). COPY-TO-json + `read_ndjson` TIMESTAMP round-trip was verified
  on the stock napi build; the slice-3 round-trip test MUST run against
  ax's shipped ICU-less static libduckdb before this is treated as fact
  (no COPY TO exists in the repo today) [R#7].
- **Import**: `ax segment import <dir>` under `withIngestLock` +
  `withCacheWrite`. Validates version + per-file sha256. Loads each table
  with a **column-intersection loader - NEW machinery built in slice 3, not
  the spool** [R#6]: the spool refuses undeclared columns and builds
  `columns=` from its own batch, and a narrower NDJSON file would NULL
  columns its `DO UPDATE` never meant to touch. The segment loader instead
  intersects (manifest columns ∩ local DDL columns), passes exactly that
  set to `read_ndjson(columns=...)`, and updates only those columns in its
  `ON CONFLICT` clause. Extra file fields are ignored by `read_ndjson`
  under explicit `columns=` (verified); missing local columns load as the
  DDL's NULL/default.
- **Re-derive**: there is NO session-scoped derive mode today
  (`IngestContext` windows by time only) [R#10]. v1: the importer computes
  `oldest = min(started_at)` over imported sessions and triggers the derive
  set with `since = ceil(now - oldest)` - a deliberately WIDE window whose
  cost is known post-#888 (full run-evidence rebuild 12s; windowed derives
  sub-second to seconds). A session-scoped derive parameter is future work,
  not assumed.
- **Idempotent** for everything a segment carries (no write-stamped tables
  ride; PK upsert with intersected columns converges).
- **Convergence claim, scoped honestly** [R#9]: rows are convergent for
  TRANSCRIPT-DERIVED columns at equal parser versions. Machine-local
  divergence is handled structurally (enrichment stripped, catalogs
  excluded, costs accepted-divergent with a manifest note). Parser-version
  drift behaves like re-ingesting locally after an upgrade.
- **Privacy**: a segment contains raw turn text and tool I/O. It is a LOCAL
  artifact moved by the user, never published; CLI help says so. No
  attribution plug (internal artifact).

## Piece 3 - content-hash watermark

### Today

`ingest_file_state` keys file rows by `(source_kind, absolute path)` with
`(mtime_ms, size)` as the change proxy - and ALREADY carries a `sha VARCHAR`
column ("a content hash" per its own doc) that file-form marks leave NULL
[R#13]. A moved or resynced file re-parses from scratch, and marks cannot
travel: their identity is a path on the exporting machine.

### Design: two-tier check, stable hash, existing column

- **Reuse the existing `sha` column** for the file-form content hash - no
  new column [R#13]. The hash is **SHA-256**, NOT `stableDigest`/`Bun.hash`:
  `stable-id.ts` itself documents that SHA-256 was chosen "so ids stay
  stable across bun versions", and a stored cross-machine hash on a
  version-unstable 64-bit hash would silently invalidate every mark on a
  bun upgrade [R#12]. This also matches the segment manifest's sha256.
- **Fast tier (hot path unchanged)**: per path, `(mtime_ms, size)` match →
  skip, no hashing, no file read.
- **Durable tier**: when `(mtime, size)` moved, the file is being read for
  parsing anyway; hash the bytes in passing (~1 GB/s, negligible against
  parse cost). If the hash equals the stored `sha` → content did not change
  (mtime churn, resync, touch): refresh mtime/size, SKIP the parse. This is
  a THIRD work-unit outcome (refresh-mark-without-parse) beside
  processed/skipped, and the check is async - the work-unit's `unchanged()`
  is currently a synchronous pre-isolate call, so the seam moves slightly
  [R#13]. Every genuinely-changed file gets hashed on every ingest that
  touches it; at measured throughput this is noise next to its parse.
- **Portability - deferred, and sketched honestly this time** [R#11]: the
  per-path row can never recognize a file that lands at a NEW path; that
  requires a hash-INDEXED lookup (`(source_kind, sha)` index, query by
  hash before parsing an unknown path). Slice 2 adds the index; the lookup
  + segment-manifest handshake land with slice 3 (segments carry source
  hashes; import writes hash-bearing marks under a sentinel path). Until
  then the delivered value is local: mtime-churn/resync resilience. The
  plan bullet's "merge-safe" promise is met only when slice 3 lands - the
  plan annotation says so rather than claiming it early.

### Migration (plan Q3 - measured, recommendation attached)

Q3 asked: re-hash all existing rows on first run, or lazily per-touch?
Measured 2026-08-19 on the full local corpus (4,743 jsonl files, 5.63 GB):
`Bun.hash` 3.6s; **SHA-256 5.9s** (the hash this design actually uses
[R#12]). Recommendation: **eager** - a version-marked one-time backfill
(sentinel-marker pattern) hashing every watermarked file that still exists;
lazy per-touch carries permanent branching to save a one-time ~6s. Rows
whose file is gone keep a NULL `sha` (they cannot fast-skip again anyway).
Operator confirmation requested; measurements recorded on #893.

## Slices (one PR each, after sign-off)

1. Layer classification (`layer` in `TABLE_METADATA`) + `TableWrite`
   declarations incl. non-stage writers + enrichment-column enumeration +
   static legality test + content-digest behavioral test. Size **M-L** (the
   survey plus the two tests; the review's counterexample list above is its
   seed).
2. Content-hash watermark: SHA-256 into the existing `sha` column, two-tier
   check with the async third outcome in the jsonl work-unit,
   `(source_kind, sha)` index, eager backfill. Size **M** (not S: the
   work-unit seam moves) [R#13].
3. `ax segment export`/`import`: COPY TO export, manifest with per-table
   column lists, column-intersection loader, wide-window re-derive, and the
   round-trip test AGAINST THE SHIPPED BINARY (export fixture store →
   import into fresh store → diff event tables → re-derive → diff derived).
   Size **M-L**.

## Open questions

1. Q3 (eager vs lazy) - measured (5.9s SHA-256); eager recommended;
   operator confirms.
2. Enrichment-column enumeration: is the `enrich` write-mode acceptable as a
   permanent named exception, or should a later phase move those columns
   into derived side-tables? (This spec freezes them as enumerated
   exceptions; moving them is out of Phase 4 scope.)
3. Segment compression (`.tar.zst`?) - v1 ships plain dirs; a flag later.
4. Should `ax segment import` require `--yes` when `ddl_hash` mismatches, or
   is the column-intersection load + warning enough?
