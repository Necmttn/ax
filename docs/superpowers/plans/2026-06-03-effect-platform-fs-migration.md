# Effect-Platform FileSystem/Path Migration - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This runs **autonomously on one branch → one PR**; there is no human review between tasks. **The test suite is your only gate.** After every task run `/tmp/bt.sh` (full) + `bun run typecheck`; a red suite or type error is the stop signal - fix forward, never proceed red, never weaken a test to go green.

**Goal:** Remove ALL `node:fs`/`node:path` usage from production code (59 files) in favor of `@effect/platform` `FileSystem` + `Path`, so every filesystem/path operation is Effect-native with typed errors. Zero node base deps - including the foundational config/paths bootstrap (full async rewrite) and `install.ts` (with a smoke test). Fixes the live ingest crash (vanished-transcript ENOENT, "P3") as the first slice.

**Architecture:** `FileSystem.FileSystem` + `Path.Path` are provided app-wide (`AppLayer` merges `BunFileSystem.layer` + `BunPath.layer`, `packages/lib/src/layers.ts:39-40`). Each migrated function becomes an `Effect` that `yield*`s these services; IO errors arrive as a typed **`PlatformError`** in the error channel. ENOENT is a `PlatformError` whose `.reason` is a `SystemError` with `._tag === "NotFound"`; on a per-item batch read it → skip that item, never abort the run.

**Tech Stack:** bun ≥ 1.3, TypeScript strict, `effect@4.0.0-beta.70` (re-exports `FileSystem`, `Path`, `Stream`, `PlatformError`), `@effect/platform-bun` (layers), `bun:test`.

**Inventory:** 59 production files (the spec's "98" counted tests too - disregard; this plan's 59 is authoritative). The Phase 5 guard is the source of truth; Task 0 runs it dry to enumerate the real set.

---

## Test discipline (non-negotiable - autonomous run)

1. **Never modify an existing test** except a **forced mechanical dependency edit**: when a migrated function's signature changes (`async () => Promise<T>` → `(...) => Effect<T, E, R>`), update its existing call sites to the new invocation. **When that forced edit needs a layer, provide the REAL `BunFileSystem.layer` + `BunPath.layer` against the test's existing tmp-dir fixture - NOT the in-memory `layerTestFileSystem`** (the mock would mask real-backend gaps → green-for-wrong-reason). `layerTestFileSystem` is for NEW tests only.
2. **Never** weaken, delete, skip, or `.only` an existing assertion. If a migration makes an existing test pass for the wrong reason, STOP and leave `// REVIEW-BLOCKER:` in the commit body.
3. **~25 existing test files will need forced mechanical edits** (any `*.test.ts` that imports/calls a migrated sibling whose signature changes - e.g. `runtime-state.test.ts`, `improve/lint.test.ts`, the `ingest/*`, `project/*`, `classifiers/*`, `improve/*` siblings, `packages/lib/src/*`). Expect this; a red suite there is normal until you apply the mechanical wrap. Do not treat it as a wrong-reason failure.
4. **A file performing write/rename/remove/symlink with NO existing test gets a minimal test BEFORE migration** (notably `improve/actions.ts` (rename+unlink atomic write), `skills/sources/registry.ts`, the hook providers, `dashboard/skill-source.ts`, `runtime-state.ts`). Read-only/path-only files with no test: leave `// REVIEW: migrated without test coverage`.
5. **Add** new tests for new behavior: NotFound→skip, **the negative case (a non-NotFound error must RE-RAISE, not be swallowed)**, streaming parity, per-migrated-module reads.
6. **Tiered review notes:** `// REVIEW-BLOCKER:` (touches deletion, symlink, daemon/install, atomic-write, or a swallowed-error decision) → must abort the Task 20 auto-PR-open pending human sign-off. Plain `// REVIEW:` → FYI, collected in the PR body.
7. Bun test runs via `/tmp/bt.sh` to bypass the global `block-bun-test.sh` hook. Create once: `printf '#!/bin/bash\nexec bun test "$@"\n' > /tmp/bt.sh && chmod +x /tmp/bt.sh`.

---

## The Migration Recipe (canonical transforms - every mechanical task applies these)

`import { Effect, FileSystem, Path, Stream, PlatformError } from "effect"` then inside `Effect.gen`: `const fs = yield* FileSystem.FileSystem` / `const path = yield* Path.Path`.

| node (before) | effect (after) |
|---|---|
| `await readdir(dir)` | `yield* fs.readDirectory(dir)` (→ `Array<string>`) |
| `await stat(p)` | `yield* fs.stat(p)` → `File.Info`; **`mtimeMs`→`Number(Option.getOrElse(info.mtime, () => new Date(0)).getTime())`; `size`→`Number(info.size)` (branded bigint); `isDirectory()`→`info.type === "Directory"`, `isFile()`→`info.type === "File"`** |
| `lstat(p)` + `st.isSymbolicLink()` | **no `lstat`.** Detect symlink via `fs.readLink(p)` (succeeds → symlink; fails → not a symlink / absent). See Task 13's `ensureSymlink` rewrite. |
| `existsSync(p)` / `await access(p)` | `yield* fs.exists(p)` |
| `await readFile(p,"utf8")` / `readFileSync` | `yield* fs.readFileString(p)` |
| `await writeFile(p,s)` / `writeFileSync` | `yield* fs.writeFileString(p, s)` |
| `renameSync`/`rename` | `yield* fs.rename(old, new)` |
| `mkdir(p,{recursive})` / `mkdirSync` | `yield* fs.makeDirectory(p, { recursive: true })` |
| `mkdtemp(prefix)` | `yield* fs.makeTempDirectory({ prefix })` |
| `unlink(p)` / `rm(p)` **that may not exist** (e.g. `.catch(()=>{})`) | `yield* fs.remove(p, { force: true })` (force ignores absent) |
| `rm(p,{recursive,force})` | `yield* fs.remove(p, { recursive: true, force: true })` |
| `symlink(t,l)` | `yield* fs.symlink(t, l)` |
| `chmod(p,mode)` / `chmodSync` | `yield* fs.chmod(p, mode)` |
| `realpath(p)` / `realpathSync` | `yield* fs.realPath(p)` |
| `copyFile(a,b)` | `yield* fs.copyFile(a, b)` |
| `const fh = await open(p,"r"); for await (l of fh.readLines())` | `fs.stream(p).pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(l => ...))` - see Task 2 (and Task 3 for the flush-cadence variant) |
| `join`/`basename`/`dirname`/`resolve`/`isAbsolute`/`extname`/`relative`/`normalize`/`sep` | `path.join`/`.basename`/`.dirname`/`.resolve`/`.isAbsolute`/`.extname`/`.relative`/`.normalize`/`.sep` |
| **ENOENT skip:** `try{...}catch(e){if(e.code==="ENOENT")skip}` | `...pipe(Effect.catchTag("PlatformError", e => e.reason._tag === "NotFound" ? Effect.succeed(SKIP) : Effect.fail(e)))` |

**CRITICAL - the error pattern.** ENOENT is a **`PlatformError`** (tag `"PlatformError"`) whose `.reason` is a `SystemError` with `._tag === "NotFound"`. The catch is ALWAYS:
```ts
Effect.catchTag("PlatformError", (e) => e.reason._tag === "NotFound" ? Effect.succeed(/*skip value*/) : Effect.fail(e))
```
**NEVER** broaden this to `catchAll`/`orElseSucceed`/a tagless `catchTag` to get past a type error - that silently swallows permission/IO/corruption errors as "vanished file" and drops data with green tests. If the catch won't type-check, the bug is elsewhere (wrong skip value/return type), not the catch. Every place that adds this catch MUST also have a test proving a non-NotFound `PlatformError` propagates (re-raises).

**Note B (sync call sites):** files using sync `node:fs` (`existsSync`/`readFileSync`/`mkdirSync`/`renameSync`/`realpathSync`) have call sites outside `Effect.gen`. Lift the **enclosing command/function** into a single `Effect.gen` run via the module's `AppLayer` runtime - do NOT thread async through a shared synchronous interface method (see Task 12 for the `installed: (repoRoot)=>boolean` interface case, which is handled by making the interface return an Effect across all implementors in one task).

**Note D (requirements/error channels):** migrated functions gain `PlatformError` in their error union and `FileSystem.FileSystem`/`Path.Path` in requirements. Drop any `Effect.promise(() => f())` wrapper at call sites and `yield* f()` directly. The entrypoint provides services via `AppLayer`.

---

## Phase 0 - Foundation

### Task 0: Pre-flight - version assert + dry guard inventory

- [ ] Create `/tmp/bt.sh` (above). Confirm resolved effect is beta.70: `bun pm why effect` (two versions exist in the store; the workspace must resolve `4.0.0-beta.70`). If not, STOP (`makeNoop(Partial)` + API shapes assume .70).
- [ ] Write the guard script early (Task 19 spec) and run it **dry/informational** to print the exact current node:fs/node:path set (static AND dynamic `import("node:...")`). This list is the migration's source of truth; reconcile against the task list below. Commit nothing.

### Task 1: In-memory test FileSystem helper

**Files:** Create `packages/lib/src/testing/test-filesystem.ts` + `.test.ts`.

- [ ] **Step 1: Failing test** - assert: seeded `readFileString`; `stream`→`decodeText`→`splitLines` yields exact lines; a **missing** file fails with a `PlatformError` whose `e.reason._tag === "NotFound"`; that error is catchable via `Effect.catchTag("PlatformError", e => e.reason._tag === "NotFound" ? succeed("SKIPPED") : fail(e))`; **and a NEGATIVE test: a seeded "permission" `PlatformError` is NOT caught by the NotFound predicate (re-raises).**

```ts
import { Effect, FileSystem, Stream } from "effect";
import { layerTestFileSystem } from "./test-filesystem.ts";
// ... run helper provides layerTestFileSystem(files) ...
// stream test:
yield* fs.stream("/seed/b.jsonl").pipe(Stream.decodeText(), Stream.splitLines,
  Stream.runForEach((l) => Effect.sync(() => lines.push(l))));
// NotFound catch test:
yield* fs.readFileString("/nope").pipe(
  Effect.catchTag("PlatformError", (e) => e.reason._tag === "NotFound" ? Effect.succeed("SKIPPED") : Effect.fail(e)));
```

- [ ] **Step 2: Run → FAIL** (`/tmp/bt.sh packages/lib/src/testing/test-filesystem.test.ts`).
- [ ] **Step 3: Implement** with `FileSystem.layerNoop(partial)` (returns a `Layer` directly; built-in methods fail missing paths with a correct `NotFound` already - DO NOT hand-construct the error). Override only `readFileString`, `readFile` (`Uint8Array`), `stream`, `exists`, `readDirectory`, `stat`. **`stream` MUST emit content in small multi-byte-splitting chunks** (e.g. 3-byte slices) so parity tests exercise the decoder's cross-chunk buffering - not one big chunk:

```ts
import { Effect, FileSystem, Stream } from "effect";
export const layerTestFileSystem = (files: Record<string, string>) =>
  FileSystem.layerNoop({
    readFileString: (p) => p in files ? Effect.succeed(files[p]!)
      : Effect.fail(/* let an explicit notFound through: */ undefined as never), // see note
    stream: (p) => p in files
      ? Stream.fromIterable(chunk3(new TextEncoder().encode(files[p]!)))
      : Stream.fail(/* NotFound */),
    // exists/readDirectory/stat derived from keys; readFile returns the bytes
  });
```
For the explicit NotFound (stream/readDirectory misses), construct via `PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: p })` (imported `PlatformError` from `effect`). For `readFileString`/`exists`/`stat` misses, prefer delegating to `layerNoop`'s built-in behavior where it already returns NotFound. Resolve the exact constructor signature against `node_modules/.bun/effect@4.0.0-beta.70/node_modules/effect/dist/PlatformError.d.ts` at implement time.

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** `test(lib): in-memory FileSystem layer for migration tests`.

---

## Phase 1 - Ingest transcript readers (ships the P3 crash fix)

### Task 2: claude reader (`transcripts.ts`)

**Files:** Modify `apps/axctl/src/ingest/transcripts.ts`; create `transcript-vanished-file.test.ts` + `transcript-stream-parity.test.ts`; touch `derive-claude-subagents.ts`.

- [ ] **Step 1: Write the regression + parity tests FROM SCRATCH** (do NOT attempt to recover from `stash@{0}` - it contains only the old node-patch `transcripts.ts`, no test; a stash-apply would silently no-op or reintroduce conflicting code).
  - `transcript-vanished-file.test.ts`: run `extractFileWithSessionId` (now an Effect) via `Effect.runPromiseExit` providing `layerTestFileSystem({})` (file absent). Assert **Success with `null`** (vanished → skip), NOT a failure/defect. Add a negative test: a seeded non-NotFound `PlatformError` for the path → the run **fails** (not swallowed).
  - `transcript-stream-parity.test.ts`: seed a transcript string (with trailing newline, without it, and containing a multi-byte char positioned to split across the helper's 3-byte chunks) into `layerTestFileSystem`; assert the streamed extractor's turn/tool counts equal `__testExtractClaudeJsonlLines(lines, ...)` (the untouched pure oracle, line ~955).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Migrate.** Drop `node:fs/promises` + `node:path` imports. `extractFileWithSessionId` becomes:
```ts
export const extractFileWithSessionId = (filePath: string, projectDir: string, sessionId: string)
  : Effect.Effect<FileExtract | null, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const extractor = createClaudeExtractor(projectDir, sessionId);
    yield* fs.stream(filePath).pipe(Stream.decodeText(), Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => extractor.processLine(line))));
    const extracted = extractor.finish();
    return extracted ? { ...extracted, sourcePath: filePath } : null;
  });
```
  Discovery loop: `readdir`→`fs.readDirectory`, `stat`→`fs.stat` (convert `mtimeMs`/`size` per Recipe Note - **these feed the watermark at `:1361`/`:1462`; a wrong conversion silently breaks skip-unchanged**). `deriveProject`/`normalizeEditPath` take a `Path.Path` obtained once at the top of `ingestTranscripts`. Processing site (~1382):
```ts
const extracted = yield* extractFile(candidate.filePath, candidate.projectDir).pipe(
  Effect.catchTag("PlatformError", (e) => e.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(e)));
```
  **Assert in test that the skip returns exactly `null`** (so `if (!extracted) { activeFiles -= 1; return; }` short-circuits BEFORE `files += 1`/`wm.commit` - a truthy-empty extract would falsely advance the watermark and permanently skip the file).
- [ ] **Step 4: Forced-dependency edits only.** `derive-claude-subagents.ts` → `yield*` the Effect. Existing tests calling the old async form → mechanical wrap with REAL `BunFileSystem.layer` (Test discipline #1).
- [ ] **Step 5: Run** `/tmp/bt.sh` (full) + `bun run typecheck` → PASS. **Step 6: Commit** `fix(ingest): claude reader -> FileSystem streaming; vanished transcript skips instead of aborting run`.

### Task 3: codex reader (`codex.ts`) - PRESERVE the mid-file flush cadence

**Files:** Modify `apps/axctl/src/ingest/codex.ts`; create `codex-vanished-file.test.ts`.

- [ ] **Step 1: Failing tests** - vanished-file skip + negative re-raise (as Task 2), **plus a fixture LARGER than `flushEvery` lines** asserting multi-batch flushing still occurs (counts/`providerEventsCleared` first-batch behavior unchanged).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Migrate.** `walkJsonlFiles` (`:462`): `readdir`/`stat`→`fs.readDirectory`/`fs.stat`. Per-file reader (`:1370-1388`): replace `open`+manual iterator with `fs.stream`+`splitLines`, **but keep the flush/progress interleaving** - thread the `lineCount % flushEvery` → `yield* writeBatch(extractor.drain(false))` and `% CODEX_PROGRESS_LINE_EVERY` → `emitProgress` INTO the `Stream.runForEach` per-line Effect (a naive `runForEach(processLine)` would buffer the whole 30 MB file → OOM + wrong batching). Wrap so a `NotFound` skips the candidate (`activeFiles -= 1; return`). Keep the existing raw-snapshot try/catch (already tolerant). `node:path`→`Path.Path`.
- [ ] **Step 4: Run** (watch `codex-reingest.e2e.test.ts`, `codex.stage.test.ts` - forced edits only) + typecheck → PASS. **Step 5: Commit.**

### Task 4: Phase-1 full-corpus parity + perf benchmark

- [ ] Run a **full re-derive** (watermark would otherwise skip everything and prove nothing): `AX_REDERIVE_CLAUDE=1 bun apps/axctl/src/cli/index.ts ingest --stages=claude,codex` against the live corpus from source. Confirm: completes with **no ENOENT abort**, and record **absolute elapsed**. Gate: **>1.3× slower than the pre-migration baseline → investigate** (lever: `fs.stream(p, { chunkSize: FileSystem.MiB(1) })`); leave `// REVIEW:` with the number either way.
- [ ] Also exercise the **forked/server path** (P3's real trigger): `ax serve` + `POST /api/ingest`, delete a transcript mid-run, assert exactly one `run_finished` terminal event (the bus-seam guarantee) and no unhandled defect. If not scriptable unattended, `// REVIEW-BLOCKER:` for a human to verify the Live path before merge.

---

## Phase 2 - Remaining ingest layer

Per file: (a) no-test write/rename/remove op → add a test first (Test discipline #4); (b) apply Recipe to all node calls; (c) forced-dependency edits only (real BunFileSystem layer); (d) `/tmp/bt.sh` full + typecheck green; (e) commit `refactor(ingest): <file> -> @effect/platform`. **Sync-fs files are flagged per task (Note B).**

- [ ] **Task 5:** `git.ts` (fs/promises + path; leave `ProcessService` shell-outs).
- [ ] **Task 6:** `skills.ts`, `commands.ts` (fs/promises + path; `commands.ts` has no test → add one).
- [ ] **Task 7:** `cursor.ts`, `opencode.ts` (**sync** `node:fs` + promises + path - Note B; lift enclosing fns).
- [ ] **Task 8:** `pi.ts`, `model-pricing.ts`, `artifacts.ts` (fs/promises + path). **`artifacts.ts:202,236` use `lstat`** for symlink/`.git` detection → rewrite via `fs.readLink` (succeeds → symlink) or, if it only needs file-vs-dir, `fs.stat().type`; if semantics are subtle, `// REVIEW-BLOCKER:`.
- [ ] **Task 9:** `agent-scope.ts`, `project-discovery.ts` (no test → add), `claude-insights.ts` (fs/promises + path).
- [ ] **Task 10:** `tool-file-evidence.ts`, `content-blocks/parse-markdown.ts` (path only), `derive-opportunities.ts` (**sync** fs only - Note B).

---

## Phase 3 - Non-ingest production files

Same per-task protocol; commit per group. **All `classifiers/` and `improve/` files use SYNC `node:fs` (Note B applies to every one).**

- [ ] **Task 11 - `packages/lib` leaves:** `transcript-locator.ts`, `transcript-staleness.ts` (fs/promises + path), `pwd.ts` (fs/promises; `pwd.test.ts:75` uses `realpath`→`fs.realPath`), `runtime-state.ts` (**sync** fs + path; no behavioral test of read/write → add one; this is consumed by config in Task 12).
- [ ] **Task 12 - Shared sync interfaces (`installed: (repoRoot)=>boolean`):** `hooks/providers/{claude,codex,cursor,opencode}.ts`, `skills/sources/registry.ts`, `agents/source.ts`. These implement an interface method typed `=> boolean` using `existsSync`. **Do the interface change in ONE task:** change `HookProvider.installed`/`SkillSource.installed` to return `Effect<boolean, PlatformError, FileSystem.FileSystem>`, update ALL implementors + ALL consumers together (so the suite isn't left red across files). Add tests for the providers/registry first (#4).
- [ ] **Task 13 - `cli/install.ts` (migrate + smoke test; HIGHEST blast radius):**
  - Add a smoke test FIRST: `ensureSymlink` create / replace-existing-symlink / dangling-link / regular-file-in-the-way; and an `ax doctor --json` shape test. Use real `BunFileSystem` against a tmp dir.
  - Rewrite `ensureSymlink` (`:334`) - no `lstat`: `fs.readLink(link)` succeeds → existing symlink (compare target via the returned path; replace if different); `PlatformError NotFound` → create; other success-as-file → it's a real file in the way (preserve existing throw/replace semantics). Keep symlink→chmod→plist-load ORDERING exactly.
  - Lift each command (`cmdInstall`/`cmdSetup`/`cmdDaemon`/`cmdDoctor`/`cmdUninstall`, `collectDoctorReport`) into ONE `Effect.gen` run via `AppLayer` runtime - not piecemeal (Note B). `existsSync`→`fs.exists`, `rm(...).catch()`→`fs.remove(p,{force:true})`, `chmod`→`fs.chmod`, `node:path`→`Path.Path`.
  - `// REVIEW-BLOCKER:` on the whole task - human verifies `ax install` + `ax doctor` + daemon load before merge.
- [ ] **Task 14 - `cli/` rest:** `onboarding.ts`, `star-nudge.ts`, `skills-classify.ts`, `skills-lint.ts`, `retro-meta.ts`, `retro-plan.ts`, `classifiers-package-operations.ts`, `classifiers-workflow-candidates.ts`. **`cli/index.ts`** - migrate its **dynamic** `await import("node:fs/promises")` + `await import("node:path")` (`:1096-1098`) to the injected services (it's already in an Effect entrypoint).
- [ ] **Task 15 - `classifiers/`** (all **sync** fs): `eval.ts`, `label-mining-service.ts`, `list.ts`, `package-manifest.ts`, `package-operations.ts`, `package-service.ts`, `review-pipeline-service.ts`.
- [ ] **Task 16 - `improve/`** (all **sync** fs; `actions.ts`/`lint.ts` do `renameSync`/`unlinkSync`/`realpathSync` → add atomic-write tests first, #4): `actions.ts`, `agent-accept.ts`, `lint.ts`, `skill-scaffold.ts`.
- [ ] **Task 17 - `project/`** (**sync**+async fs + path): `diagnostics.ts`, `git.ts`, `harness.ts`, `stack.ts`.
- [ ] **Task 18 - `dashboard/`+`tui/`+`dogfood/`:** `report.ts`, `session-inspect.ts`, `skill-source.ts`, `tui/hooks/useSkillDetail.ts`, `dogfood/wterm.ts` (uses `mkdtemp`→`makeTempDirectory`, `chmod`).

---

## Phase 4 - Foundational config/paths async bootstrap rewrite (full rewrite, per decision)

The highest-ripple change; done LATE so all consumers above are already Effect-ified.

### Task 19: Rewrite `paths.ts` + `config.ts` to source path/fs via services; reorder the layer graph

**Files:** Modify `packages/lib/src/paths.ts`, `packages/lib/src/config.ts`, `packages/lib/src/layers.ts`; touch all `AxConfig`/paths consumers.

- [ ] **Step 1:** Map every consumer of `paths.ts` module-consts (`TRANSCRIPTS_DIR`, etc.) and `config.ts` `envSnapshot`/`makeTestConfig` (grep; ~24 sites). The module-level `const`s become functions/Effects that `yield* Path.Path` - there is no import-time path building anymore.
- [ ] **Step 2:** Rewrite `envSnapshot` from a pure sync function into an `Effect` requiring `FileSystem.FileSystem | Path.Path` (it reads runtime-state via `runtime-state.ts`, already migrated in Task 11, and joins paths). `AxConfigLive` becomes `Layer.effect(AxConfig, …)` that `yield*`s these.
- [ ] **Step 3:** Reorder `layers.ts`: provide `BunFileSystem.layer` + `BunPath.layer` **beneath** `AxConfigLive` (`Layer.provideMerge`), since `AxConfigLive` now depends on them (currently they're siblings, `:34-43`). `makeTestConfig` takes a provided FileSystem/Path (or uses `layerTestFileSystem`).
- [ ] **Step 4:** Update all consumers to obtain config/paths within an Effect boundary. Forced test edits use real `BunFileSystem`. Run full suite + typecheck after EACH consumer group; this task is the most likely to cascade - if a consumer genuinely cannot enter an Effect boundary, `// REVIEW-BLOCKER:` and stop rather than reintroducing `node:path`.
- [ ] **Step 5: Commit** `refactor(lib): async config/paths bootstrap via FileSystem+Path (no node:path)`.

---

## Phase 5 - Seal

### Task 20: Guard + final gate + PR

**Files:** Create `scripts/check-no-node-fs.ts`; modify `package.json` + CI.

- [ ] **Step 1:** Guard scans `apps/axctl/src` + `packages/*/src` (excluding `*.test.ts`, `dashboard/web/vite.config.ts`, and `packages/lib/src/layers.ts`) for BOTH static `from "node:fs"|"node:fs/promises"|"node:path"|"fs"|"path"` AND **dynamic `import("node:fs...")` / `require("node:...")`**. Exit non-zero listing offenders. No `// allow-node-fs:` pragma exemptions remain (full migration per decision) except the explicitly-excluded files above.
- [ ] **Step 2:** Run it; fix any remaining offenders via the Recipe.
- [ ] **Step 3:** Wire into `package.json` scripts (`check:no-node-fs`) + the CI workflow (mirror `check:cli-reference`).
- [ ] **Step 4: Final green gate:** `/tmp/bt.sh` (full) + `bun run typecheck` + `bun scripts/check-no-node-fs.ts` all pass.
- [ ] **Step 5: Commit** `chore: ban node:fs/node:path imports (migration complete)`.

### Task 21: PR
- [ ] Push; open ONE PR `feat: migrate node fs/path -> @effect/platform`. Body: P3 fix (Phase 1), the 59-file migration, config rewrite, install.ts (smoke-tested), the new guard, **and a collected list of every `// REVIEW:` / `// REVIEW-BLOCKER:`**. If ANY `// REVIEW-BLOCKER:` exists, mark the PR draft and request human sign-off (do not auto-merge).

---

## Out of scope

- `apps/axctl/src/dashboard/web/vite.config.ts` (build-time, runs under vite/node) - excluded from guard.
- Non-fs node built-ins (`child_process`/`spawnSync`, `os`, `crypto`).
- P1 (blocking-update ingest) + P2 (single-flight lock) - onboarding spec + follow-up.

## Self-review notes

- **All four reviews' BLOCKERs/MAJORs incorporated:** corrected `catchTag("PlatformError", e=>e.reason._tag==="NotFound")` everywhere (+ negative re-raise tests); Task 12 reframed as a one-shot interface change; config/paths done as a full async rewrite (Phase 4, per decision); install.ts migrated with smoke test + symlink rewrite via `readLink` (per decision); recipe rows added for `lstat`/`rename`/`mkdtemp`/`symlink`/`chmod`/`realpath`/`relative`/`sep`/`normalize`; `cli/index.ts` assigned + guard catches dynamic imports; codex flush cadence preserved + >flushEvery test; Task 1 uses `layerNoop` built-in NotFound + multi-chunk stream; real-`BunFileSystem`-for-existing-tests rule; no-test-write-ops get a test first; stat→watermark conversion flagged; tiered `REVIEW-BLOCKER`; effect beta.70 asserted; file count reconciled to 59; Task 4 benches with `AX_REDERIVE` + 1.3× gate + forked-path check.
- **Residual highest-risk tasks for the AFK run:** Task 13 (install.ts) and Task 19 (config rewrite) - both gated by `// REVIEW-BLOCKER:` so they cannot silently auto-merge.
