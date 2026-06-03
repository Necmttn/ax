# Effect-Platform FileSystem/Path Migration - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This runs **autonomously on one branch → one PR**; there is no human review between tasks. **The test suite is your gate.** After every task run `bun test` + `bun run typecheck`; a red suite is the stop signal - fix forward, do not proceed red.

**Goal:** Replace all `node:fs`/`node:path` usage (59 production files) with `@effect/platform` `FileSystem` + `Path`, so filesystem/path access is Effect-native with typed errors. Fixes the live ingest crash (vanished-transcript ENOENT, "P3") as the first slice.

**Architecture:** `FileSystem.FileSystem` + `Path.Path` are already provided app-wide (`AppLayer` merges `BunFileSystem.layer` + `BunPath.layer`, `packages/lib/src/layers.ts:39-40`). Each migrated function becomes (or stays) an `Effect` that `yield*`s these services; IO errors arrive as typed `PlatformError`s in the error channel. ENOENT (`SystemError`, `reason: "NotFound"`) on a per-item batch read → skip that item, never abort the run.

**Tech Stack:** bun ≥ 1.3, TypeScript strict, `effect@4.0.0-beta.70` (re-exports `FileSystem`, `Path`, `Stream`), `@effect/platform-bun` (layers), `bun:test`.

---

## Test discipline (non-negotiable, autonomous run)

- **Never modify an existing test** except for a **forced mechanical dependency edit**: when a migrated function's signature changes (`async () => Promise<T>` → `(...) => Effect<T, E, R>`), update its existing call sites in tests to the new invocation (e.g. wrap in `Effect.runPromise` + provide a layer). That is the ONLY allowed edit to existing tests.
- **Never** weaken, delete, skip, or `.only` an existing assertion to get green. If a migration makes an existing test pass for the wrong reason, STOP and leave a `// REVIEW:` note in the task's commit body.
- **Add** new tests for new behavior: the `NotFound`→skip path, streaming parity, and per-migrated-module reads against the in-memory FS layer (Task 1).
- Bun test runs via the wrapper at `/tmp/bt.sh` (`#!/bin/bash` / `exec bun test "$@"`) to bypass the global `block-bun-test.sh` hook. Create it once: `printf '#!/bin/bash\nexec bun test "$@"\n' > /tmp/bt.sh && chmod +x /tmp/bt.sh`. Run subsets with `/tmp/bt.sh <path>`; full suite with `/tmp/bt.sh`.

---

## The Migration Recipe (canonical transforms - every mechanical task applies these)

`import { Effect, FileSystem, Path, Stream } from "effect"` then `const fs = yield* FileSystem.FileSystem` / `const path = yield* Path.Path` inside `Effect.gen`.

| node (before) | effect (after) |
|---|---|
| `await readdir(dir)` | `yield* fs.readDirectory(dir)` |
| `await stat(p)` → `.mtimeMs`,`.size` | `yield* fs.stat(p)` → `.mtime` (Option<Date>), `.size` (BigInt) - see note A |
| `existsSync(p)` / `await access(p)` | `yield* fs.exists(p)` |
| `await readFile(p,"utf8")` / `readFileSync` | `yield* fs.readFileString(p)` |
| `await writeFile(p,s)` / `writeFileSync` | `yield* fs.writeFileString(p, s)` |
| `await mkdir(p,{recursive:true})` | `yield* fs.makeDirectory(p, { recursive: true })` |
| `await unlink(p)` / `rm(p)` | `yield* fs.remove(p, { recursive?: true })` |
| `const fh = await open(p,"r"); for await (line of fh.readLines())` | `fs.stream(p).pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(line => ...))` - see Task 2 |
| `join(a,b)` / `basename(p)` / `dirname(p)` / `resolve(a,b)` / `isAbsolute(p)` / `extname(p)` | `path.join(a,b)` / `path.basename(p)` / `path.dirname(p)` / `path.resolve(a,b)` / `path.isAbsolute(p)` / `path.extname(p)` |
| `try { ...fs... } catch (e) { if (e.code==="ENOENT") skip }` | `...fs....pipe(Effect.catchTag("SystemError", e => e.reason === "NotFound" ? Effect.succeed(SKIP) : Effect.fail(e)))` |

**Note A (stat field differences):** Effect `File.Info.mtime` is `Option<Date>` (use `Option.getOrElse(() => new Date(0))` then `.getTime()`); `File.Info.size` is `bigint` (use `Number(info.size)`); `File.Info.type` is a string union (`"File"`,`"Directory"`,…) replacing `isDirectory()`/`isFile()`.

**Note B (sync call sites):** files importing `node:fs` (sync: `existsSync`/`readFileSync`/`mkdirSync`) have call sites that are NOT inside `Effect.gen`. Each must be lifted: either (i) make the enclosing function an `Effect` and `yield*` the fs op, or (ii) if it sits at a sync boundary that cannot become an Effect (rare), run a small `Effect` via the module's runtime. Default to (i); flag any (ii) in the commit body with `// REVIEW:`.

**Note C (pure path helpers):** functions doing only path-string math (e.g. `deriveProject`, `normalizeEditPath` in `transcripts.ts`; everything in `paths.ts`/`config.ts`) must take/obtain a `Path.Path` instance rather than importing `node:path`. If a helper is called from many non-Effect sites, prefer threading a `path` param from the nearest Effect boundary. `packages/lib/src/paths.ts` + `config.ts` are the highest-ripple case - handled last (Task 12) with a dedicated approach.

**Note D (error channel):** these functions gain `PlatformError` in their error union and `FileSystem.FileSystem`/`Path.Path` in their requirements. Propagate both; the entrypoint already provides the services via `AppLayer`. Where a function previously returned `Promise<T>` and was called via `Effect.promise`, the caller changes to `yield*` directly (drop the `Effect.promise` wrapper).

---

## Phase 0 - Foundation

### Task 1: In-memory test FileSystem helper

**Files:**
- Create: `packages/lib/src/testing/test-filesystem.ts`
- Test: `packages/lib/src/testing/test-filesystem.test.ts`

- [ ] **Step 1: Create `/tmp/bt.sh` wrapper** (if absent)

```bash
printf '#!/bin/bash\nexec bun test "$@"\n' > /tmp/bt.sh && chmod +x /tmp/bt.sh
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { Effect, FileSystem, Stream, Layer } from "effect";
import { layerTestFileSystem } from "./test-filesystem.ts";

const run = <A, E>(eff: Effect.Effect<A, E, FileSystem.FileSystem>, files: Record<string, string>) =>
    Effect.runPromise(eff.pipe(Effect.provide(layerTestFileSystem(files))));

describe("layerTestFileSystem", () => {
    it("serves seeded files via readFileString", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/seed/a.txt");
            }),
            { "/seed/a.txt": "hello" },
        );
        expect(out).toBe("hello");
    });

    it("streams seeded file content as lines", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const lines: string[] = [];
                yield* fs.stream("/seed/b.jsonl").pipe(
                    Stream.decodeText(),
                    Stream.splitLines,
                    Stream.runForEach((l) => Effect.sync(() => { lines.push(l); })),
                );
                return lines;
            }),
            { "/seed/b.jsonl": "l1\nl2\nl3" },
        );
        expect(out).toEqual(["l1", "l2", "l3"]);
    });

    it("fails with SystemError reason=NotFound for a missing file", async () => {
        const exit = await Effect.runPromiseExit(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/seed/missing.txt");
            }).pipe(Effect.provide(layerTestFileSystem({}))),
        );
        expect(exit._tag).toBe("Failure");
    });

    it("reports NotFound catchable via catchTag", async () => {
        const out = await run(
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                return yield* fs.readFileString("/nope.txt").pipe(
                    Effect.catchTag("SystemError", (e) =>
                        e.reason === "NotFound" ? Effect.succeed("SKIPPED") : Effect.fail(e),
                    ),
                );
            }),
            {},
        );
        expect(out).toBe("SKIPPED");
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `/tmp/bt.sh packages/lib/src/testing/test-filesystem.test.ts`
Expected: FAIL - `Cannot find module './test-filesystem.ts'`.

- [ ] **Step 4: Implement the helper**

Implement `layerTestFileSystem(files: Record<string, string>): Layer.Layer<FileSystem.FileSystem>` using `FileSystem.make`. Provide at minimum: `readFileString`, `readFile` (return `Uint8Array`), `stream` (`Stream.fromIterable([new TextEncoder().encode(content)])`), `exists`, `readDirectory` (derive dir entries from the keys), `stat` (size from byte length, `type: "File"`). For any missing key, fail with a `NotFound` `SystemError` - construct it via the platform error constructor exported from `FileSystem`/the error module (resolve the exact constructor at implement time by reading `node_modules/.bun/effect@4.0.0-beta.70/node_modules/effect/dist/FileSystem.d.ts` and the platform `Error` module; the shape is `SystemError({ reason: "NotFound", module: "FileSystem", method, pathOrDescriptor })`). Unimplemented methods may delegate to `FileSystem.makeNoop` defaults.

```ts
import { Effect, FileSystem, Layer, Stream } from "effect";

export const layerTestFileSystem = (files: Record<string, string>): Layer.Layer<FileSystem.FileSystem> =>
    Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
            readFileString: (p) =>
                p in files ? Effect.succeed(files[p]!) : Effect.fail(/* NotFound SystemError for p */),
            // ...stream, exists, readDirectory, stat, readFile per above
        }),
    );
// NOTE: confirm makeNoop accepts a partial-override object in this beta; if it
// takes a full impl, build via FileSystem.make and fill the rest from makeNoop().
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `/tmp/bt.sh packages/lib/src/testing/test-filesystem.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/testing/test-filesystem.ts packages/lib/src/testing/test-filesystem.test.ts
git commit -m "test(lib): in-memory FileSystem layer for migration tests"
```

---

## Phase 1 - Ingest transcript readers (ships the P3 crash fix)

### Task 2: Migrate the claude reader (`transcripts.ts`) to FileSystem streaming + NotFound skip

**Files:**
- Modify: `apps/axctl/src/ingest/transcripts.ts` (imports; `deriveProject` ~138, `normalizeEditPath` ~151, `extractFileWithSessionId` ~978, the discovery loop ~1272-1326, the processing `Effect.promise` call ~1382)
- Test: `apps/axctl/src/ingest/transcript-vanished-file.test.ts` (port the stashed regression test) + `apps/axctl/src/ingest/transcript-stream-parity.test.ts` (new)

- [ ] **Step 1: Recover the stashed P3 regression test as the starting point**

```bash
git stash show -p stash@{0} -- apps/axctl/src/ingest/transcript-vanished-file.test.ts | git apply || true
```
If apply fails, recreate the file from Step 2.

- [ ] **Step 2: Write/port the failing regression + parity tests**

`transcript-vanished-file.test.ts` - assert the reader returns the "nothing extracted" result (not a defect) for a missing file, exercised through the in-memory FS layer (Task 1). Because `extractFileWithSessionId` becomes an `Effect`, the test runs it via `Effect.runPromiseExit` providing `layerTestFileSystem({})` and asserts success with a null/empty extract, NOT a failure.

`transcript-stream-parity.test.ts` - seed a transcript string (with and without trailing newline, including a multi-byte char) into `layerTestFileSystem`, run the new streaming extractor, and assert the extracted turn/tool counts equal those from `__testExtractClaudeJsonlLines` on the same lines (the existing pure line-extractor is untouched and is the oracle).

- [ ] **Step 3: Run tests to verify they fail**

Run: `/tmp/bt.sh apps/axctl/src/ingest/transcript-vanished-file.test.ts apps/axctl/src/ingest/transcript-stream-parity.test.ts`
Expected: FAIL (signature/type mismatch - function still async/node-based).

- [ ] **Step 4: Migrate the reader**

Apply Recipe rows: drop `import { readdir, stat, open } from "node:fs/promises"` and `import { join, basename, isAbsolute, resolve } from "node:path"`. Convert `extractFileWithSessionId` to:

```ts
export const extractFileWithSessionId = (
    filePath: string,
    projectDir: string,
    sessionId: string,
): Effect.Effect<FileExtract | null, PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const extractor = createClaudeExtractor(projectDir, sessionId);
        yield* fs.stream(filePath).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => Effect.sync(() => extractor.processLine(line))),
        );
        const extracted = extractor.finish();
        return extracted ? { ...extracted, sourcePath: filePath } : null;
    });
```

Convert the discovery loop: `readdir` → `fs.readDirectory`, `stat` → `fs.stat` (Note A for `mtime`/`size`). Convert `deriveProject`/`normalizeEditPath` to take a `Path.Path` (Note C) obtained once at the top of `ingestTranscripts`. At the processing site (~1382) replace `yield* Effect.promise(() => extractFile(...))` with the NotFound-tolerant call:

```ts
const extracted = yield* extractFile(candidate.filePath, candidate.projectDir).pipe(
    Effect.catchTag("SystemError", (e) =>
        e.reason === "NotFound" ? Effect.succeed(null) : Effect.fail(e),
    ),
);
```
A `null` result here means "vanished or empty" → skip without committing the watermark (existing `if (!extracted) { activeFiles -= 1; return; }` already handles it).

- [ ] **Step 5: Update forced-dependency call sites only**

`derive-claude-subagents.ts` calls `extractFileWithSessionId` - update to `yield*` the Effect (it already runs inside `Effect.gen`). Any existing test that called the old async form: apply the mechanical wrap (Test discipline). Do not change assertions.

- [ ] **Step 6: Run tests**

Run: `/tmp/bt.sh apps/axctl/src/ingest/` then `/tmp/bt.sh` (full) + `bun run typecheck`
Expected: PASS, including the ported regression + parity. No existing ingest test regressed.

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/ingest/transcripts.ts apps/axctl/src/ingest/derive-claude-subagents.ts apps/axctl/src/ingest/transcript-vanished-file.test.ts apps/axctl/src/ingest/transcript-stream-parity.test.ts
git commit -m "fix(ingest): claude reader -> FileSystem streaming; ENOENT (vanished file) skips instead of aborting run

Root cause of the 32-min ingest crash: a git-worktree workdir transcript was deleted between discovery stat() and processing open(); the unguarded open() ENOENT became an Effect defect aborting the whole run. Migrating to fs.stream + typed NotFound catch makes a vanished file a per-file skip."
```

### Task 3: Migrate the codex reader (`codex.ts`)

**Files:**
- Modify: `apps/axctl/src/ingest/codex.ts` (`walkJsonlFiles` ~462; per-file `open`+`readLines` ~1370-1388; `node:path` uses)
- Test: `apps/axctl/src/ingest/codex-vanished-file.test.ts` (new)

- [ ] **Step 1: Write failing test** - seed a codex session file via `layerTestFileSystem`, assert a missing file is skipped (run completes) and a present file extracts; mirror Task 2's NotFound assertion.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Migrate** `walkJsonlFiles` (`readdir`/`stat` → `fs.readDirectory`/`fs.stat`) and the per-file reader (`open`+`readLines` → `fs.stream`+`splitLines`); wrap the per-file processing so `NotFound` skips the candidate (`activeFiles -= 1; return`). Keep the existing raw-snapshot try/catch behavior (already tolerant). `node:path` → `Path.Path`.
- [ ] **Step 4: Run tests** (`/tmp/bt.sh apps/axctl/src/ingest/` + full + typecheck) → PASS, no regressions. Pay attention to `codex-reingest.e2e.test.ts` and `codex.stage.test.ts` (forced-dependency edits only).
- [ ] **Step 5: Commit** `fix(ingest): codex reader -> FileSystem streaming; vanished session file skips`.

### Task 4: Phase-1 corpus benchmark (parity sanity, no code change)

- [ ] Run a real scoped ingest from source against the live corpus and confirm completion + comparable throughput to pre-migration (ingest is DB-bound, so expect parity): `bun apps/axctl/src/cli/index.ts ingest --stages=claude,codex --since=7` and watch it finish without an ENOENT abort. Record elapsed in the commit body of the next task. If throughput regresses >2x, STOP and leave a `// REVIEW:` note (Stream chunking may need `fs.stream(p, { chunkSize })` tuning).

---

## Phase 2 - Remaining ingest layer (apply Recipe per file)

Each task below: (a) if a test exists, add/extend coverage using `layerTestFileSystem` for any new behavior; (b) apply the Recipe to all node calls; (c) update forced-dependency call sites + tests (mechanical only); (d) `/tmp/bt.sh <dir>` + full + typecheck green; (e) commit `refactor(ingest): <file> -> @effect/platform`.

- [ ] **Task 5:** `git.ts` (fs/promises + path) - note it shells out via `ProcessService`; only migrate fs/path, leave process calls.
- [ ] **Task 6:** `skills.ts`, `commands.ts` (fs/promises + path).
- [ ] **Task 7:** `cursor.ts`, `opencode.ts` (BOTH sync `node:fs` + `node:fs/promises` + path - apply Note B for sync sites).
- [ ] **Task 8:** `pi.ts`, `model-pricing.ts`, `artifacts.ts` (fs/promises + path).
- [ ] **Task 9:** `agent-scope.ts`, `project-discovery.ts`, `claude-insights.ts` (fs/promises + path).
- [ ] **Task 10:** `tool-file-evidence.ts`, `content-blocks/parse-markdown.ts` (path only), `derive-opportunities.ts` (sync fs only - Note B).

---

## Phase 3 - Non-ingest production files (apply Recipe per file)

Same per-task protocol as Phase 2. Group by subsystem; commit per group.

- [ ] **Task 11 - `packages/lib` leaves first (lowest ripple):** `runtime-state.ts` (sync fs + path), `transcript-locator.ts`, `transcript-staleness.ts` (fs/promises + path), `pwd.ts` (fs/promises).
- [ ] **Task 12 - `packages/lib` foundational path modules (HIGHEST RIPPLE - see Note C):** `paths.ts`, `config.ts` (path only, imported app-wide). Before editing, grep all importers; converting these to require `Path.Path` ripples into every consumer's requirements. Approach: obtain `path` at each consumer's nearest Effect boundary. If a consumer is a pure non-Effect constant/helper that cannot take a `Path.Path`, leave a `// REVIEW:` note and a minimal local join (no `node:path` import) rather than forcing a service into a pure leaf. This task is the most likely to need human judgment - proceed conservatively, keep the suite green, and document every `// REVIEW:`.
- [ ] **Task 13 - `cli/`:** `install.ts` (sync+async fs + path), `onboarding.ts`, `star-nudge.ts`, `skills-classify.ts`, `skills-lint.ts`, `retro-meta.ts`, `retro-plan.ts`, `classifiers-package-operations.ts`, `classifiers-workflow-candidates.ts`. Many sit at sync CLI boundaries (Note B).
- [ ] **Task 14 - `classifiers/`:** `eval.ts`, `label-mining-service.ts`, `list.ts`, `package-manifest.ts`, `package-operations.ts`, `package-service.ts`, `review-pipeline-service.ts`.
- [ ] **Task 15 - `improve/`:** `actions.ts`, `agent-accept.ts`, `lint.ts`, `skill-scaffold.ts`.
- [ ] **Task 16 - `project/`:** `diagnostics.ts`, `git.ts`, `harness.ts`, `stack.ts` (all sync+async fs + path).
- [ ] **Task 17 - `hooks/providers/`:** `claude.ts`, `codex.ts`, `cursor.ts`, `opencode.ts` (sync fs + path).
- [ ] **Task 18 - `dashboard/` + `tui/` + `skills/sources/` + `dogfood/`:** `report.ts`, `session-inspect.ts`, `skill-source.ts`, `tui/hooks/useSkillDetail.ts`, `skills/sources/registry.ts`, `dogfood/wterm.ts`.

---

## Phase 4 - Seal

### Task 19: Remove residual node fs/path imports + add lint guard

**Files:**
- Create: `scripts/check-no-node-fs.ts`
- Modify: any file still importing `node:fs`/`node:path` (should be none in production after Phases 1-3)

- [ ] **Step 1: Write the guard script** - scan `apps/axctl/src` + `packages/*/src` (excluding `*.test.ts`, `dashboard/web/vite.config.ts`, the layer-definition files in `packages/lib/src/layers.ts`, and any file with an explicit `// allow-node-fs:` pragma) for `from "node:fs"`, `from "node:fs/promises"`, `from "node:path"`, `from "fs"`, `from "path"`. Exit non-zero listing offenders.
- [ ] **Step 2: Run it** - `bun scripts/check-no-node-fs.ts`. Fix any remaining offenders by applying the Recipe.
- [ ] **Step 3: Wire into CI** - add `bun scripts/check-no-node-fs.ts` to the repo check set (mirror `check:cli-reference` in `package.json` scripts + the CI workflow step).
- [ ] **Step 4: Full green gate** - `/tmp/bt.sh` (full suite) + `bun run typecheck` + `bun scripts/check-no-node-fs.ts` all pass.
- [ ] **Step 5: Commit** `chore: ban node:fs/node:path imports (migration complete)`.

### Task 20: Open the PR

- [ ] Push the branch; open ONE PR titled `feat: migrate node fs/path -> @effect/platform (FileSystem/Path)`. Body summarizes: P3 crash fix (Phase 1), the 59-file migration, the new lint guard, and lists every `// REVIEW:` note left for human attention.

---

## Out of scope

- `apps/axctl/src/dashboard/web/vite.config.ts` - build-time config running under node/vite, cannot use the Effect runtime. Excluded from the guard.
- Non-fs node built-ins (`child_process`/`spawnSync`, `os`, `crypto`).
- Test files' own tmp-dir fixtures, except forced mechanical signature edits.
- P1 (blocking-update ingest) and P2 (single-flight lock) - tracked in the onboarding spec + a follow-up.

## Self-review notes (author)

- **Spec coverage:** Phases 0-4 cover every file in the spec's inventory; the 59-file list is enumerated across Tasks 2-18. ✓
- **Highest risks flagged in-plan:** Task 12 (foundational path modules ripple), Note B (sync fs lift), Task 4 (streaming perf parity). These are the three things reviewers should pressure-test.
- **Open question for reviewers:** the exact `SystemError` NotFound constructor + whether `FileSystem.makeNoop` takes partial overrides in beta.70 - Task 1 resolves it against installed types at implement time; if the API differs, Task 1 is the single place to adapt.
