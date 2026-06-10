# Profiling ingest with OTLP traces

ax exports every Effect span (and log/metric) over OTLP/HTTP when
`AX_OTLP_URL` is set. Unset, the exporter layer is `Layer.empty` - zero
overhead, no behavior change. The seam is
`packages/lib/src/otel.ts` (`otlpTelemetryFromEnv`), wired beneath
`LiveTraceLayer` in `packages/lib/src/layers.ts` so the existing LiveTrace
progress spans and the OTLP exporter both see the same span tree.

## Quick start (Maple local)

```bash
brew install Makisuo/tap/maple
scripts/trace-ingest.sh --since=1 --stages=claude   # starts maple if needed
maple traces --format table                          # or the UI at local.maple.dev
```

Any axctl invocation works, not just ingest:

```bash
AX_OTLP_URL=http://127.0.0.1:4318 bun apps/axctl/src/cli/index.ts sessions metrics --here
```

Maple listens for OTLP/HTTP on `127.0.0.1:4318`; ax appends `/v1/traces`
etc. itself. Any OTLP collector works (Jaeger, otel-desktop-viewer, ...) -
point `AX_OTLP_URL` at it.

## What is instrumented

Span hierarchy for an ingest run (names you can filter on):

- `<stage key>` - one span per pipeline stage (`LiveTrace.step` in
  `apps/axctl/src/ingest/stage/runner.ts`), tagged `ingest.stage.tags`.
  - `transcripts.file` - one span per Claude transcript candidate
    (attrs: `file.path`, `file.size`). Watermark-skipped files show as
    sub-millisecond spans.
    - `transcripts.parse` - JSONL parse/extract (attr: `file.size`)
    - `transcripts.snapshot` - raw-transcript blob upload
      (attr: `snapshot.bytes`)
    - `transcripts.upsertSessions` - session row upsert
    - `db.exec:<label>` - one span per write-helper batch
      (`upsertTurns`, `providerEvidence`, `toolCalls`, `hookEvidence`,
      `invokedEdges`, ...), attrs: `db.exec.statements`, `db.exec.chunks`.
      - `db.chunk` - one span per `db.query()` roundtrip
        (attrs: `db.chunk.index`, `db.chunk.statements`)

Every write that routes through the shared
`packages/lib/src/shared/statement-exec.ts` seam gets `db.exec`/`db.chunk`
spans automatically; pass `{ label }` in `ExecuteOptions` to attribute a
call site.

## Sampling methodology

Profile against a quiet DB or the numbers lie:

1. `launchctl bootout gui/$UID/com.necmttn.ax-watch` - stop watcher re-fires
2. wait for `surreal` CPU to settle (`ps aux | rg surreal`)
3. run progressively bigger samples: one stage (`--stages=claude`) →
   source stages (`--stages=claude,codex,git,opencode`) → full default set
4. `AX_REDERIVE_CLAUDE=1` forces re-parse of watermark-skipped transcripts
   when you need a repeatable workload
5. restore:
   `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.necmttn.ax-watch.plist`
