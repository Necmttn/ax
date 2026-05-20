# Converge hook writes onto the ingest statement path

`axctl` has two graph-write paths: ingest builds SurrealQL `UPSERT`/`RELATE`
statements and executes them in chunks; hooks call `db.upsert()` one row at a
time via `writeTelemetryRow`. ADR-0004 makes Harness Hook Events first-class
Local Evidence, so the hook path is load-bearing, not incidental.

Two write paths means new telemetry tables have no canonical pattern. We
converge: `writeTelemetryRow` builds an `UPSERT` statement using the shared
`surql.ts` literal toolkit and runs it through the shared statement executor -
the same seam ingest uses. `db.upsert` / `db.relate` remain on `SurrealClient`
as escape hatches but are no longer the telemetry write path.

Consequence: one write path, one place escaping/record-id rules live, and hook
evidence rows are built and tested the same way as ingest evidence rows.
