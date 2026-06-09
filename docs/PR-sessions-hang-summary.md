# PR: unhang session queries + ingest single-flight + share perf

Branch `fix/sessions-hang`. Started from a hung `ax sessions here --days=120`;
root-caused and fixed a family of `IN [...]`-membership-scan read hotspots plus
the ingest wedge that starved SurrealDB. Also hardens the proud-session-seed
demo path end-to-end (the seed doc's own footnote describes the same wedge).

## Headline wins

| Path | Before | After |
|------|--------|-------|
| `ax sessions here --days=120` (798 sessions) | 90s+ hang | **0.7s** |
| `ax share` (29-subagent session) | 45–54s | **1.5s** |
| ingest wedge (ax-watch `--since=1`) | stuck 5h, pegged DB | single-flight lock + 900s hard cap |

## What changed

**Reads - kill `IN [<ids>]` membership scans over big tables.** SurrealDB
evaluates `field IN [array]` as a per-row membership test (not an index
lookup), so cost is O(rows × ids). Replaced with per-id **indexed** lookups
fanned out at bounded concurrency:
- `enrichSessions` (`sessions-query.ts`): per-session `session = <lit>` hitting
  `turn_session_seq`, concurrency from `AxConfig.knobs.sessionsEnrichConcurrency`.
- `resolveTurnContent` (`session-turn-content.ts`): per-document
  `document = <rid>` hitting `content_block_document_seq` /
  `content_atom_document_kind`, replacing `document IN [<all docs>]` (was 6s +
  22s over 430k blocks / 1.1M atoms). Output byte-identical (629/1551 verified).
- New `content_document_session (session, source_kind)` index: turn-doc
  resolution 600ms → 0.3ms.

**Ingest - single-flight + hard timeout (`ingest-lock.ts`, `cmdIngest`).**
Atomic `wx`-create advisory lock at `$dataDir/ingest.lock`; a fresh live-owned
lock makes a second ingest SKIP (the watcher re-fires anyway); dead/stale locks
are stolen. A hard wall-clock cap (`AxConfig.knobs.ingestTimeoutSeconds`,
default 900s) self-cancels a wedged ingest; a timed-out/interrupted run LEAVES
its lock to age into a cooldown so the next run can't charge a still-busy DB.

**CLI - fix the dead escape hatch.** `--no-stale-check` / `--stale-threshold`
were read by the handler but never registered on `sessions here`/`near`, so the
parser rejected them. Registered both. The `sessions here` auto-backfill is now
timeboxed (`Effect.timeoutOption`, 20s) so a busy DB never hangs the read.

**Config - Effect-native.** Both new tunables live in `AxConfig.knobs` (single
env boundary in `config.ts`), not raw `process.env` reads.

## Tests
`ingest-lock` (8), `sessions-query` (13, asserts the indexed shape),
`session-turn-content` (2, regression-guards no `document IN`), plus
exporter/artifact/config/schema. typecheck clean (axctl + lib); effect-lint
(`@effect/language-service`) clean on all changed code.

## Verified by dogfooding (the proud-session-seed demo)
Drove the seed prompt against the fixed DB and published 3 public shares - all
fast, no wedge:
- `fb1be39a` - 29 subagents, timeline UI + perf wins → 0.16.0:
  https://ax.necmttn.com/s/Necmttn/77fd35f66094fe777e7875889c73115c
- `b23ebb28` - @ax/studio Electron extraction, 768 tool_calls → 0.15.0:
  https://ax.necmttn.com/s/Necmttn/51d98957752632f6bbeedd81934dcb1c
- `11fb5aad` - recovery arc, 24 recoveries + 4 corrections, classifiers lifecycle:
  https://ax.necmttn.com/s/Necmttn/1b9b38f33908a0d4aa7b3b1a8d019b73

## Note for reviewers / deploy
`content_document_session` lands via `axctl install` (`surreal import` of
schema.surql; `DEFINE INDEX IF NOT EXISTS` is idempotent) - re-run install on
upgrade so the share speedup applies to existing DBs.

See `docs/proud-session-seed-loop-log.md` for the per-iteration trail.
