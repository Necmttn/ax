# Sidecar Judgment Cutover Report

Status: DONE

## Result

The request paths now use the typed `Judgment` service for the remaining judgment data.

This data includes skill triage, role decisions, improvement records, reviews, retros, dogfood runs, and spar labels.

Shared readers now prevent duplicate SQL in the dashboard, profile, and command paths.

The doctor command now checks references from the sidecar to the published cache.

The ingest runtime does not open the SQLite judgment database.

The dashboard runtime supplies the cache reader and judgment services at the request boundary.

Manual retro input works when SurrealDB is not available.

Dogfood writes transcript content to a durable artifact input file.

The `dogfood_run` row stores only the artifact identifier.

The separate live writer worktree has no changes from this work.

## Storage Rules

SQLite contains only the existing judgment tables and columns.

DuckDB keeps deterministic facts.

The OTLP spool keeps telemetry data.

The implementation has no SurrealDB fallback or dual write.

Stable identifiers use the natural keys for each judgment record.

## Verification

`bun run typecheck` exits with status 0.

The non-Electron test suite has 5,448 passes, 15 skips, and no failures.

The focused proposal test has 11 passes and no failures.

The complete suite reports four Electron setup errors.

The Electron package installation is incomplete in this worktree.

Real SQLite tests cover write, read, transaction, reconciliation, and integrity behavior.

Dead SurrealDB tests cover the cutover request paths.

Two review agents found no remaining code or specification defects.

## Commits

- `ef5b0d46 feat(v2): port triage and brief role judgments`
- `ae985df4 feat(v2): port request-time judgments to sidecar`
- `4799d5df feat(v2): complete judgment reader cutover`
- `874658d1 fix(v2): close sidecar judgment review gaps`
- `81b2169f test(v2): cover all sidecar proposal forms`

No commit is pushed or merged.
