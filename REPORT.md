# w2-live-writers report

## Result

The work unit is complete.

Live readers now take `CacheReadService` as an argument.

Ingest callers pass the lock-held `CacheWriteService`.

Ingest writers now use DuckDB row writes and bound SQL values.

The CLI run, stage, timeout, and maintenance paths no longer use SurrealDB.

The dashboard OTLP receiver appends each request to the durable JSONL spool.

## Important fixes

- Git session filters bind all repository paths.
- PR merge watermarks delete removed rows.
- PR merge watermarks wait for missing merge commits.
- OTLP correlation writes one session edge.
- OTLP retention deletes old rows and dangling edges.
- Ingest run finalizers settle success and failure rows.
- DUAL parity tests read seeded session and telemetry rows.
- Corrected skill invocation keys use the normalized turn record key.

Old tests that asserted SurrealQL text were removed with the old builders.

Real DuckDB tests replace the critical writer, parity, and deletion checks.

## Verification

- `bun run typecheck` passes.
- `bun test apps/axctl/src` passes with 3,927 tests and 8 skips.
- `bun run check:no-node-fs` passes for 670 files.
- `bun run build` passes.
- `ELECTRON_OVERRIDE_DIST_PATH=/tmp bun test` passes with 5,804 tests and 14 skips.

The plain repository test command finds no local Electron binary.

The Electron override supplies the standard test path and all four tests pass.

## Commits

- `d49f4395` `refactor(v2): widen ingest stage errors`
- `ece4574b` `feat(v2): port live readers and ingest writers`
- `d87bb8e5` `fix(v2): complete DuckDB writer migration`

No commit was pushed or merged.
