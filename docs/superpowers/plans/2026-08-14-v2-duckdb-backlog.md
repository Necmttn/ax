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

### Wave 2 - seam ports (partition emitted by w1-seam-design, 2026-08-15)

248 non-test source files still import `SurrealClient` / `@ax/lib/db`. They split into five
mechanical chunks below, drawn along the SEAM ROLE each file plays, not along directory names -
a writer and a reader need different seam calls, different tests, and different review, so a
chunk that mixed them would have no single acceptance criterion.

Every chunk follows the template `ax recall` set in w1 (`apps/axctl/src/queries/recall.ts`,
`apps/axctl/src/dashboard/recall.ts`, `apps/axctl/src/cli/commands/recall.ts`, and the two test
files beside them). Read it FIRST - it answers the four questions every port hits:

- **BM25 is a SCORE, not a boolean.** `fts_main_<t>.match_bm25(alias.id, ?)` returns NULL when a
  row does not match. Score once in a subquery, filter `score IS NOT NULL` outside it. A `WHERE
  match_bm25(...)` is a silent wrong answer, not an error.
- **Record derefs become JOINs.** `session.project` was a Surreal link; `turn.session` is a plain
  VARCHAR holding the row id. Join it. Deref-avoidance rules written for Surreal (denormalised
  `invoked.session`, `has_content.session`) still pay off - they are now ordinary columns.
- **Every value binds.** Surreal could not bind record-id arrays, which forced record literals
  into the SQL text; DuckDB row ids are plain strings, so `AND id IN (?, ?, ?)` works and the
  string-built SQL - with its injection surface - goes away. The builder test asserts the
  generated SQL contains no quote character.
- **Column meanings are named.** Import the contracts from `@ax/lib/duckdb/columns`
  (`TimestampColumn`, `JsonArrayColumn`, `JsonObjectColumn`, `NumberFromBigIntColumn`) instead of
  spelling `Schema.Date` / `Schema.String` per call site. Arrays and nested objects are JSON TEXT
  in a VARCHAR - the bun:ffi client cannot decode a native LIST.

Shared rules for all five:

- Ports are REPLACEMENTS. No dual-run, no fallback to Surreal on a DuckDB miss - a fallback hides
  exactly the bug the port introduces.
- Tests run against a REAL temp DuckDB built from the real `schema.duckdb.sql`, via
  `duckdbTestSetup` (`@ax/lib/testing/duckdb-dylib`). SQL-text assertions do not count as
  coverage; they cannot tell a working query from one that merely looks right.
- Raw-client imports (`DuckDb`, `DuckDbLayer`, `openDuckDbService`) come from
  `@ax/lib/duckdb/internal` and are a review flag in a query: the seam exists to keep reads
  read-only and writes lock-held.
- `packages/lib/src/**` may not import `node:fs` / `node:path` (R6, `bun run check:no-node-fs`).

Chunk boundaries by seam role. Files listed exhaustively; a file appears in exactly one chunk.

- **w2-ingest-writers** [lane: mechanical] - 71 files. Every WRITE path: `withCacheWrite`
  under `withIngestLock`, `put`/`putMany` for row writes, `exec` for anything else. Watch for the
  three stamped columns (`WRITE_STAMPED_COLUMNS`) the DDL cannot express, and for rows missing an
  `id` - the upsert names `id` as its conflict target and refuses without one. FTS index builds
  (`buildFtsIndexes`) belong at ingest FINISH, after the last write.
  - `apps/axctl/src/advice/advice-stage.ts`
  - `apps/axctl/src/agents/cli.ts`
  - `apps/axctl/src/agents/config.ts`
  - `apps/axctl/src/agents/reconcile.ts`
  - `apps/axctl/src/config-core/reconcile.ts`
  - `apps/axctl/src/digest/digest-stage.ts`
  - `apps/axctl/src/digest/snapshot.ts`
  - `apps/axctl/src/digest/sources.ts`
  - `apps/axctl/src/ingest/agent-def.ts`
  - `apps/axctl/src/ingest/agent-event-index-heal.ts`
  - `apps/axctl/src/ingest/backfill-invoked-positions.ts`
  - `apps/axctl/src/ingest/classifier-results.ts`
  - `apps/axctl/src/ingest/claude-config.ts`
  - `apps/axctl/src/ingest/claude-insights.ts`
  - `apps/axctl/src/ingest/claude-sidecars.ts`
  - `apps/axctl/src/ingest/closure.ts`
  - `apps/axctl/src/ingest/codex.ts`
  - `apps/axctl/src/ingest/commands.ts`
  - `apps/axctl/src/ingest/content-blocks/persist.ts`
  - `apps/axctl/src/ingest/cursor.ts`
  - `apps/axctl/src/ingest/derive-checkpoints.ts`
  - `apps/axctl/src/ingest/derive-claude-subagents.ts`
  - `apps/axctl/src/ingest/derive-content-types.ts`
  - `apps/axctl/src/ingest/derive-cost-backfill.ts`
  - `apps/axctl/src/ingest/derive-directive-ngrams.ts`
  - `apps/axctl/src/ingest/derive-intents.ts`
  - `apps/axctl/src/ingest/derive-loaded-skills.ts`
  - `apps/axctl/src/ingest/derive-metrics.ts`
  - `apps/axctl/src/ingest/derive-opportunities.ts`
  - `apps/axctl/src/ingest/derive-proposals.ts`
  - `apps/axctl/src/ingest/derive-retro-proposals.ts`
  - `apps/axctl/src/ingest/derive-run-evidence.ts`
  - `apps/axctl/src/ingest/derive-signals.ts`
  - `apps/axctl/src/ingest/derive-spawned.ts`
  - `apps/axctl/src/ingest/dry-run.ts`
  - `apps/axctl/src/ingest/evidence-writers.ts`
  - `apps/axctl/src/ingest/git.ts`
  - `apps/axctl/src/ingest/github-pr-stage.ts`
  - `apps/axctl/src/ingest/github-pr-write.ts`
  - `apps/axctl/src/ingest/harness.ts`
  - `apps/axctl/src/ingest/jsonl-work-unit.ts`
  - `apps/axctl/src/ingest/model-pricing.ts`
  - `apps/axctl/src/ingest/normalized/transcripts.ts`
  - `apps/axctl/src/ingest/opencode.ts`
  - `apps/axctl/src/ingest/otel-spool.ts`
  - `apps/axctl/src/ingest/outcomes.ts`
  - `apps/axctl/src/ingest/pi.ts`
  - `apps/axctl/src/ingest/provider-events.ts`
  - `apps/axctl/src/ingest/reaction-events.ts`
  - `apps/axctl/src/ingest/reap-runs.ts`
  - `apps/axctl/src/ingest/retro.ts`
  - `apps/axctl/src/ingest/run.ts`
  - `apps/axctl/src/ingest/schema-drift.ts`
  - `apps/axctl/src/ingest/session-health.ts`
  - `apps/axctl/src/ingest/signals/core.ts`
  - `apps/axctl/src/ingest/skill-role.ts`
  - `apps/axctl/src/ingest/skill-upsert.ts`
  - `apps/axctl/src/ingest/skills.ts`
  - `apps/axctl/src/ingest/transcripts.ts`
  - `apps/axctl/src/ingest/turn-analysis.ts`
  - `apps/axctl/src/ingest/turn-content-blocks.ts`
  - `apps/axctl/src/otel/correlate.ts`
  - `apps/axctl/src/otel/retention.ts`
  - `apps/axctl/src/otel/signal.ts`
  - `apps/axctl/src/otel/writer.ts`
  - `apps/axctl/src/sdk/session-store.ts`
  - `apps/axctl/src/skills/cli.ts`
  - `apps/axctl/src/skills/config.ts`
  - `apps/axctl/src/skills/reconcile.ts`
  - `apps/axctl/src/skills/sources/registry.ts`
  - `apps/axctl/src/usage/usage-stage.ts`
- **w2-read-queries** [lane: mechanical] - 53 files. Pure read surfaces behind `CacheRead`:
  the analytics and metrics queries the CLI, dashboard and MCP all call. Each returns rows decoded
  through an explicit `Schema.Struct` of column contracts. `count(*)` comes back as a BIGINT, so
  it decodes as `Schema.BigInt` (or `NumberFromBigIntColumn`), never as `Schema.Number`.
  - `apps/axctl/src/context/file-context-pack.ts`
  - `apps/axctl/src/context/file-evidence-rank.ts`
  - `apps/axctl/src/context/file-evidence.ts`
  - `apps/axctl/src/metrics/aggregates.ts`
  - `apps/axctl/src/metrics/catalog.ts`
  - `apps/axctl/src/metrics/cold-start-reads.ts`
  - `apps/axctl/src/metrics/commit-reverted.ts`
  - `apps/axctl/src/metrics/cost-estimate.ts`
  - `apps/axctl/src/metrics/delegation-ratio.ts`
  - `apps/axctl/src/metrics/durability.ts`
  - `apps/axctl/src/metrics/fragility-cascade.ts`
  - `apps/axctl/src/metrics/pr-merge-dirty.ts`
  - `apps/axctl/src/metrics/reverted-commits.ts`
  - `apps/axctl/src/metrics/session-churn.ts`
  - `apps/axctl/src/metrics/session-loc.ts`
  - `apps/axctl/src/metrics/session-metrics-query.ts`
  - `apps/axctl/src/metrics/time-to-first-edit.ts`
  - `apps/axctl/src/metrics/time-to-land.ts`
  - `apps/axctl/src/profile/queries.ts`
  - `apps/axctl/src/profile/render.ts`
  - `apps/axctl/src/queries/advice-ledger.ts`
  - `apps/axctl/src/queries/content-types.ts`
  - `apps/axctl/src/queries/context-budget.ts`
  - `apps/axctl/src/queries/cost-analytics.ts`
  - `apps/axctl/src/queries/directive-ngrams.ts`
  - `apps/axctl/src/queries/dispatch-analytics.ts`
  - `apps/axctl/src/queries/enriched-session.ts`
  - `apps/axctl/src/queries/feedback-cases.ts`
  - `apps/axctl/src/queries/hook-latency.ts`
  - `apps/axctl/src/queries/hooks.ts`
  - `apps/axctl/src/queries/image-context.ts`
  - `apps/axctl/src/queries/ingest-staleness.ts`
  - `apps/axctl/src/queries/insights-enrich.ts`
  - `apps/axctl/src/queries/memory-ops.ts`
  - `apps/axctl/src/queries/otel-rollup.ts`
  - `apps/axctl/src/queries/routability.ts`
  - `apps/axctl/src/queries/routing-backtest.ts`
  - `apps/axctl/src/queries/run-evidence.ts`
  - `apps/axctl/src/queries/session-turn-content.ts`
  - `apps/axctl/src/queries/sidecar-usage.ts`
  - `apps/axctl/src/queries/skill-bloat.ts`
  - `apps/axctl/src/queries/skill-detail.ts`
  - `apps/axctl/src/queries/skill-hygiene.ts`
  - `apps/axctl/src/queries/skill-loaded.ts`
  - `apps/axctl/src/queries/skill-stats.ts`
  - `apps/axctl/src/queries/spar-sessions.ts`
  - `apps/axctl/src/queries/telemetry-rollup.ts`
  - `apps/axctl/src/queries/thinking-analytics.ts`
  - `apps/axctl/src/queries/unused-skills.ts`
  - `apps/axctl/src/queries/workflow-sequences.ts`
  - `apps/axctl/src/team/team-profile-queries.ts`
  - `apps/axctl/src/timeline/service.ts`
  - `apps/axctl/src/usage/query.ts`
- **w2-dashboard** [lane: mechanical] - 42 files. HTTP route handlers and the OpenTUI views.
  Mostly a service swap - `CacheReadLive` is already merged into the web handler's layer - plus
  the timestamp boundary: the seam decodes TIMESTAMP to a `Date`, the JSON API contract carries
  ISO strings, so the mapping is explicit at the response edge (see `dashboard/recall.ts`).
  - `apps/axctl/src/dashboard/classifier-explain.ts`
  - `apps/axctl/src/dashboard/contract/otel.ts`
  - `apps/axctl/src/dashboard/contract/system.ts`
  - `apps/axctl/src/dashboard/contract/web-handler.ts`
  - `apps/axctl/src/dashboard/cost-query.ts`
  - `apps/axctl/src/dashboard/cost-summary-query.ts`
  - `apps/axctl/src/dashboard/episode-timeline.ts`
  - `apps/axctl/src/dashboard/graph-explorer.ts`
  - `apps/axctl/src/dashboard/improve-proposals.ts`
  - `apps/axctl/src/dashboard/ingest-workflow.ts`
  - `apps/axctl/src/dashboard/loc-query.ts`
  - `apps/axctl/src/dashboard/next-actions.ts`
  - `apps/axctl/src/dashboard/project.ts`
  - `apps/axctl/src/dashboard/reap-loop.ts`
  - `apps/axctl/src/dashboard/report.ts`
  - `apps/axctl/src/dashboard/role-queries.ts`
  - `apps/axctl/src/dashboard/router/router.ts`
  - `apps/axctl/src/dashboard/router/routes/live.ts`
  - `apps/axctl/src/dashboard/session-baselines.ts`
  - `apps/axctl/src/dashboard/session-canvas.ts`
  - `apps/axctl/src/dashboard/session-compare.ts`
  - `apps/axctl/src/dashboard/session-detail.ts`
  - `apps/axctl/src/dashboard/session-insights.ts`
  - `apps/axctl/src/dashboard/session-inspect.ts`
  - `apps/axctl/src/dashboard/session-summary.ts`
  - `apps/axctl/src/dashboard/session-view.ts`
  - `apps/axctl/src/dashboard/sessions-list.ts`
  - `apps/axctl/src/dashboard/sessions-query.ts`
  - `apps/axctl/src/dashboard/skill-graph.ts`
  - `apps/axctl/src/dashboard/skill-source.ts`
  - `apps/axctl/src/dashboard/skills-weighted.ts`
  - `apps/axctl/src/dashboard/tool-failures.ts`
  - `apps/axctl/src/dashboard/triage.ts`
  - `apps/axctl/src/dashboard/workflow.ts`
  - `apps/axctl/src/dashboard/worktrees-overview.ts`
  - `apps/axctl/src/dashboard/wrapped-cards.ts`
  - `apps/axctl/src/dashboard/wrapped.ts`
  - `apps/axctl/src/tui/App.tsx`
  - `apps/axctl/src/tui/hooks/useLiveInvocations.ts`
  - `apps/axctl/src/tui/hooks/useSkillDetail.ts`
  - `apps/axctl/src/tui/hooks/useSkills.ts`
  - `apps/axctl/src/tui/index.tsx`
- **w2-cli-mcp** [lane: mechanical] - 54 files. Command handlers, the MCP tool registry, the
  improve/hooks/dojo surfaces. `CacheRead` is provided on all three CLI runtime paths already; the
  work is per-handler. NOTE `cli/commands/recall.ts` is in this list only for `resolveScope`,
  which still resolves a repository through `pwd.ts` (chunk E) - its recall query is ported.
  - `apps/axctl/src/classifiers/facts.ts`
  - `apps/axctl/src/classifiers/label-mining-service.ts`
  - `apps/axctl/src/classifiers/package-service.ts`
  - `apps/axctl/src/cli/classifiers-package-operations.ts`
  - `apps/axctl/src/cli/classifiers-workflow-candidates.ts`
  - `apps/axctl/src/cli/commands/ax-directives.ts`
  - `apps/axctl/src/cli/commands/dogfood.ts`
  - `apps/axctl/src/cli/commands/improve.ts`
  - `apps/axctl/src/cli/commands/ingest.ts`
  - `apps/axctl/src/cli/commands/manifest.ts`
  - `apps/axctl/src/cli/commands/recall.ts`
  - `apps/axctl/src/cli/commands/report.ts`
  - `apps/axctl/src/cli/commands/retro.ts`
  - `apps/axctl/src/cli/commands/sessions.ts`
  - `apps/axctl/src/cli/commands/skills.ts`
  - `apps/axctl/src/cli/index.ts`
  - `apps/axctl/src/cli/install.ts`
  - `apps/axctl/src/cli/project.ts`
  - `apps/axctl/src/cli/retro-meta.ts`
  - `apps/axctl/src/cli/retro-plan.ts`
  - `apps/axctl/src/cli/retro-reflect.ts`
  - `apps/axctl/src/cli/skills-classify.ts`
  - `apps/axctl/src/cli/skills-lint.ts`
  - `apps/axctl/src/cli/skills-tag.ts`
  - `apps/axctl/src/dogfood/wterm.ts`
  - `apps/axctl/src/dojo/agenda.ts`
  - `apps/axctl/src/dojo/report.ts`
  - `apps/axctl/src/dojo/skill-spar.ts`
  - `apps/axctl/src/dojo/spar.ts`
  - `apps/axctl/src/hooks/backtest.ts`
  - `apps/axctl/src/hooks/bench.ts`
  - `apps/axctl/src/hooks/cli.ts`
  - `apps/axctl/src/hooks/config.ts`
  - `apps/axctl/src/hooks/dedup.ts`
  - `apps/axctl/src/hooks/dispatch-install.ts`
  - `apps/axctl/src/hooks/file-context-hook.ts`
  - `apps/axctl/src/hooks/log.ts`
  - `apps/axctl/src/hooks/sdk-install.ts`
  - `apps/axctl/src/hooks/telemetry.ts`
  - `apps/axctl/src/improve/actions.ts`
  - `apps/axctl/src/improve/housekeep.ts`
  - `apps/axctl/src/improve/impact.ts`
  - `apps/axctl/src/improve/lint.ts`
  - `apps/axctl/src/improve/list.ts`
  - `apps/axctl/src/improve/propose.ts`
  - `apps/axctl/src/improve/recommend.ts`
  - `apps/axctl/src/improve/report-queries.ts`
  - `apps/axctl/src/improve/show.ts`
  - `apps/axctl/src/improve/verdict-pending.ts`
  - `apps/axctl/src/improve/verdicts.ts`
  - `apps/axctl/src/mcp/tools.ts`
  - `apps/axctl/src/self-improve/commands.ts`
  - `apps/axctl/src/share/exporter.ts`
  - `apps/axctl/src/share/recover.ts`
- **w2-lib-core** [lane: judgment] - 28 files, and the one chunk that is NOT mechanical. It
  holds the Surreal client itself (`packages/lib/src/db.ts`), the shared query/watermark helpers
  every other chunk sits on, `pwd.ts` (cwd -> repository, which several commands need), and the
  one-off scripts. Sequence it FIRST for the helpers the other four import, and LAST for the
  client deletion - which belongs to wave 3's `c-surreal-delete`, not here.
  - `apps/axctl/src/project/context.ts`
  - `apps/axctl/src/project/harness.ts`
  - `apps/axctl/src/pwd.ts`
  - `apps/axctl/src/routing-impact/io.ts`
  - `packages/lib/src/blob-gc.ts`
  - `packages/lib/src/db.ts`
  - `packages/lib/src/errors.ts`
  - `packages/lib/src/layers.ts`
  - `packages/lib/src/shared/graph-query.ts`
  - `packages/lib/src/shared/ingest-staleness.ts`
  - `packages/lib/src/shared/query.ts`
  - `packages/lib/src/shared/surreal.ts`
  - `packages/lib/src/shared/watermark.ts`
  - `packages/lib/src/telemetry-base.ts`
  - `packages/lib/src/testing/surreal.ts`
  - `packages/lib/src/transcript-locator.ts`
  - `packages/lib/src/transcript-staleness.ts`
  - `scripts/benchmark-turn-fts.ts`
  - `scripts/classifier-smoke.ts`
  - `scripts/classifier-window-export.ts`
  - `scripts/experiment-turn-fts.ts`
  - `scripts/prototypes/ax-hook-report.ts`
  - `scripts/prototypes/churn-gate-probe.ts`
  - `scripts/prototypes/dupe-probe.ts`
  - `scripts/prototypes/loaded-skills-run.ts`
  - `scripts/prototypes/skillrev-backfill-probe.ts`
  - `scripts/repair-agent-event-index.ts`
  - `scripts/test-getfile.ts`

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
