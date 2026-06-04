# Migration: node `fs`/`path` → `@effect/platform` FileSystem/Path

**Date:** 2026-06-03
**Status:** approved (design)
**Branch:** `feat/effect-platform-fs-migration`
**Supersedes:** the standalone P3 ENOENT fix (`fix/ingest-enoent-vanished-transcript`, stashed) - folded in as Phase 1.

## Problem

`ax ingest` crashed mid-run with an unhandled `ENOENT`:

```
✕ ingest done  8/25 stages  elapsed=32:31  failed=2
axctl error: ENOENT: no such file or directory, open
  '/Users/necmttn/.claude/projects/-Users-necmttn-multica-workspaces-…-workdir/…jsonl'
  syscall: "open", errno: -2, code: "ENOENT"
```

Root cause (**P3**): the claude reader `extractFileWithSessionId` (`apps/axctl/src/ingest/transcripts.ts:983`) and the codex reader (`apps/axctl/src/ingest/codex.ts:1370`) call `await open(filePath, "r")` with no error handling. Discovery `stat()`s a transcript into the work list (`transcripts.ts:1317`); 30 minutes later the processing pass `open()`s it - but a **git-worktree workdir was cleaned up meanwhile**, deleting its `~/.claude/projects/<slug>/*.jsonl`. The `open()` rejects with `ENOENT`; because it runs under `Effect.promise` (`transcripts.ts:1382`), which expects no rejection, the rejection becomes an **unrecoverable defect** that aborts the whole ingest run.

This is a *class* of bug: untyped node `fs` rejections crossing an `Effect.promise` boundary become defects. The structural fix is to make filesystem access Effect-native, where errors are typed `PlatformError`s in the error channel that callers must handle.

## Goal

Replace all `node:fs`/`node:path` usage (**59 production files**; the earlier "98" counted test files too) with `@effect/platform`'s `FileSystem` + `Path` services, so every filesystem/path operation is Effect-native, returns typed errors, and is testable against an in-memory filesystem layer. The vanished-file crash (P3) is fixed as **Phase 1**.

**Locked scope decisions (post multi-agent review):**
- **Full config/paths async rewrite** - `paths.ts`/`config.ts` foundational path building is rewritten to source `Path.Path`/`FileSystem` (layer graph reordered); no `node:path` survives even in module-level/sync bootstrap. (Done late, Phase 4 of the plan.)
- **`install.ts` is migrated**, not deferred - with a smoke test (`ax install`/`ax doctor`/symlink) and the symlink detection rewritten via `fs.readLink` (no `lstat`). Gated `REVIEW-BLOCKER`.
- **Symlink detection rewritten** (no `node:fs` `lstat`) at all sites (`artifacts.ts`, `install.ts`).

## Why this is the right shape

- **Typed errors:** ENOENT surfaces as a `PlatformError` (tag `"PlatformError"`) whose `.reason` is a `SystemError` with `._tag === "NotFound"`. The catch is `Effect.catchTag("PlatformError", e => e.reason._tag === "NotFound" ? skip : fail)` - NEVER broaden it (a tagless/`catchAll` swallows permission/IO/corruption as "vanished file"). A vanished file becomes an explicit skip, not a defect that kills the run; non-NotFound errors MUST re-raise (negative-tested).
- **Testability:** swap `BunFileSystem` for an in-memory FileSystem layer in tests - no tmp-dir fixtures, deterministic.
- **Consistency:** ~10 files already use `FileSystem`/`Path` (`agent-def.ts`, `agents/*`, `skills/reconcile.ts`, `cli/index.ts`…). This finishes the job and removes node-base-dep reliance.
- **Layer already wired:** `AppLayer` merges `BunFileSystem.layer` + `BunPath.layer` (`packages/lib/src/layers.ts:39-40`), so the services are provided app-wide already. No new layer plumbing for the common path.

## API mapping

In this beta, `FileSystem` + `Path` are re-exported from `effect` directly:
`import { Effect, FileSystem, Path, Stream } from "effect"`.

| node | `@effect/platform` (via `effect`) |
|---|---|
| `readdir(dir)` | `fs.readDirectory(dir)` |
| `stat(p)` | `fs.stat(p)` → `File.Info` (`.size`, `.mtime`, `.type`) |
| `open(p,"r")` + `fh.readLines()` | `fs.stream(p)` ▸ `Stream.decodeText()` ▸ `Stream.splitLines` ▸ `Stream.runForEach`/`Sink` |
| `readFile`/`fh` text | `fs.readFileString(p)` |
| `existsSync(p)` / `exists` | `fs.exists(p)` |
| `writeFile(p, s)` | `fs.writeFileString(p, s)` |
| `mkdir(p,{recursive})` | `fs.makeDirectory(p, { recursive: true })` |
| `unlink(p)` | `fs.remove(p)` |
| `join`/`basename`/`dirname`/`resolve`/`isAbsolute` | `path.join`/`.basename`/`.dirname`/`.resolve`/`.isAbsolute` (`Path.Path`) |
| `try/catch (ENOENT)` | `Effect.catchTag("PlatformError", e => e.reason._tag === "NotFound" ? skip : fail)` |

All `fs.*` return `Effect.Effect<T, PlatformError>`; all `path.*` are pure methods on the `Path.Path` service value.

## Signature impact

- `async` functions that do fs IO become `Effect`s with `FileSystem.FileSystem` (and `Path.Path` where they did path math) in their requirements channel. Callers already inside `Effect.gen` just `yield*` them; the requirement propagates and is satisfied once by `AppLayer` at the entrypoint.
- Functions called from non-Effect code (rare) are lifted into Effect at their nearest Effect boundary, or run via the existing `AppLayer` runtime.
- Pure path-string helpers (e.g. `deriveProject`, `normalizeEditPath` in `transcripts.ts`) take a `Path.Path` instance (acquired via `yield* Path.Path` in their caller) rather than importing `node:path`. Where a helper is purely synchronous string math and lifting it is pure overhead, it is flagged in the phase PR for a judgment call (lift vs. accept a `Path.Path` param) - but **no `node:path` import remains**.

## Error-handling policy

- **`NotFound` (ENOENT)** on a per-item read in a batch pass (transcript files, session files) → **skip that item** (log debug, continue). Never aborts the run. This is P3's fix, generalized.
- **Other `PlatformError`s** (permission, IO) → propagate by default; a stage may choose to log-and-skip per-item if that matches existing tolerance (e.g. codex's raw-snapshot read already swallows on failure, `codex.ts:1406-1410`).
- A single bad file must never abort a whole-corpus stage: per-item processing is wrapped so item failures are isolated (defense-in-depth), with `NotFound` skipped silently and other errors logged.

## Execution model

This lands as a **single branch → single PR**, executed **autonomously / unattended** (no human review between phases). The phases below are an *internal ordering* for the executing agent (crash-first, dependency-respecting), NOT separate PRs. Consequences:

- **Tests are the only gate.** The full `bun test` suite + `bun run typecheck` must be green at the end, and ideally kept green phase-to-phase. There is no human checkpoint, so a red suite is the stop signal.
- **Do NOT modify existing tests** - they are the regression guard for the migration. The sole exception is a **forced dependency change**: when migrating a function changes its signature (e.g. `async` → `Effect`), the existing tests that call it must be updated to the new signature/invocation - that is a mechanical dependency edit, not a behavioral one. Never weaken, delete, or skip an existing assertion to make the suite pass.
- **Expand tests where coverage is thin.** Add new tests for new behavior (the `NotFound`→skip path, streaming parity, per-migrated-module reads against the in-memory FS layer). New tests are additive.
- **A green suite must mean what it meant before.** If a migration would make an existing test pass for the wrong reason, stop and surface it rather than editing the test.

## Phasing (internal execution order within the single PR; crash-first, dependency-respecting)

**Phase 0 - Foundation.**
- Confirm the ingest runtime resolves through `AppLayer` (FileSystem + Path already merged). Add nothing if already satisfied.
- Add a reusable **test FileSystem layer** helper (in-memory) for unit tests - seed files, assert reads, simulate `NotFound`.

**Phase 1 - Ingest transcript readers (ships the P3 fix).**
- `transcripts.ts`: `readdir`/`stat`/`open`+`readLines` → `fs.readDirectory`/`fs.stat`/`fs.stream`+`Stream.splitLines`. ENOENT on a candidate → typed `NotFound` catch → skip (no watermark commit). `node:path` → `Path.Path`.
- `codex.ts`: same for `walkJsonlFiles` (`:462`) + the per-file `open`/`readLines` (`:1370`).
- `derive-claude-subagents.ts` (consumes `extractFileWithSessionId`): update to the new Effect signature.
- Port the P3 regression test (currently `transcript-vanished-file.test.ts`, stashed) to assert: a candidate whose file is absent yields a skip and the run completes - exercised via the in-memory FS layer.
- **Benchmark** Phase 1 against current on the real corpus (1 GB claude / 1.3 GB codex): confirm no parse/throughput regression from `Stream` vs `readLines`.

**Phase 2 - Remaining ingest layer.**
`cursor.ts`, `pi.ts`, `opencode.ts`, `skills.ts`, `commands.ts`, `artifacts.ts`, `agent-scope.ts`, `project-discovery.ts`, `claude-insights.ts`, `model-pricing.ts`, and any other `node:fs`/`node:path` users under `apps/axctl/src/ingest/`.

**Phase 3 - Non-ingest.**
`cli/`, `tui/`, `hooks/`, `agents/`, `config/`, `context/`, `pwd.ts`, and remaining `packages/*` users. Path-service churn (Risk 2) is absorbed here.

**Phase 4 - Seal.**
- Delete the last `node:fs`/`node:path` imports.
- Add a lint guard (oxlint `no-restricted-imports` or a `scripts/check-*.ts`) banning direct `node:fs`/`node:fs/promises`/`node:path` imports outside an allowlist (e.g. the layer-definition files), so the migration can't regress.

## Testing

- **Existing suite is the regression guard** - keep it green throughout; only edit an existing test when a migrated signature forces a mechanical call-site change (see Execution model). Never relax an assertion.
- Per migrated file: prefer the in-memory FileSystem layer (Phase 0 helper) for *new* tests; override the layer in `bun:test`. Existing tmp-dir fixture tests stay as-is unless a signature change forces an update.
- P3 regression: `NotFound` mid-batch → skip + run completes (Phase 1).
- Streaming parity: a fixture transcript with/without trailing newline, multi-byte UTF-8, and a large (>10 MB) file produce identical extracted records under `fs.stream`+`splitLines` vs the prior `readLines`.
- CI: `bun test` + `bun run typecheck` per phase; the compiled-binary smoke (existing `build-artifacts`) still boots.

## Risks

1. **Streaming parity** - `fs.stream`+`Stream.splitLines` must match `fh.readLines()` exactly (trailing newline handling, encoding, very large files). Mitigation: parity test + Phase 1 benchmark. (Ingest is already DB-round-trip-bound - see the 93%-in-`kevent64` finding - so Stream overhead is unlikely to dominate, but verify.)
2. **Path-service churn** - honoring "no node base deps" pushes `Path.Path` into many pure helpers for zero IO benefit. Mitigation: Phase 3 isolates it; flag pure-overhead helpers per PR for lift-vs-param judgment.
3. **59-file diff** - large surface. Mitigation: strict phasing, one PR per phase, tests per slice, the Phase 4 lint guard prevents backsliding.
4. **Non-Effect call sites** - a few fs uses sit outside Effect (sync CLI paths). Mitigation: lift to the nearest Effect boundary or run via `AppLayer`; called out per file in its phase.

## Out of scope

- Non-fs node built-ins (`child_process`/`spawnSync`, `os`, `crypto`) - unless trivially adjacent to a migrated file.
- The separate ingest concerns surfaced during diagnosis: **P1** (`ax update` triggering a blocking full ingest) and **P2** (no single-flight ingest lock). These belong to the onboarding-redesign spec (`2026-06-03-onboarding-tiered-ingest-design.md`) and a follow-up, respectively - not this migration.
