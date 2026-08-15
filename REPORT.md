# w2-live-writers report

## Result

DONE.

The P1 and P2 remediation is complete.

Live readers use `CacheReadService`.

Ingest callers pass the lock-held `CacheWriteService`.

Ingest writers use DuckDB row writes and bound SQL values.

The CLI paths no longer use SurrealDB.

The dashboard OTLP receiver writes each request to the durable JSONL spool.

## Remediation

- The change restores all 49 deleted test suites.
- Pure logic tests keep their original coverage.
- Engine tests use the real DuckDB schema and cache seam.
- The tests decode query results through Effect schemas.
- No restored test checks obsolete SurrealQL text.
- The Git test runs `ingestGit` against real DuckDB.
- The Cursor code no longer exports the unused statement budget.
- Churn parity seeds one failed check and one later successful check.
- Churn parity verifies one closed episode and non-empty aggregates.
- OTLP retention stays in `runIngest` and reports typed failures.
- The maintenance report includes OTLP retention failures.
- The OTLP retention test uses real DuckDB.
- Current comments describe DuckDB row writes.

## Verification

- `bun run typecheck` passes.
- `bun test` passes with 6,087 tests and 14 skips.
- `bun run build` passes.
- `bun run check:no-node-fs` passes for 670 files.
- `bun run check:table-coverage` passes.
- `git diff --check` passes.
- Standards review reports no hard violations.
- Spec review items are corrected in `b5100746`.

## Commits

- `d49f4395` `refactor(v2): widen ingest stage errors`
- `ece4574b` `feat(v2): port live readers and ingest writers`
- `d87bb8e5` `fix(v2): complete DuckDB writer migration`
- `70ddf10d` `fix(v2): stop maintenance writes publishing a partial snapshot`
- `8dceaf1e` `test(v2): decode through the schema in the cache test double`
- `9981aa46` `test(v2): restore migrated ingest coverage`
- `8b85bfa6` `docs(v2): update cache writer comments`
- `b5100746` `test(v2): close remaining ingest review gaps`

No commit was pushed or merged.
