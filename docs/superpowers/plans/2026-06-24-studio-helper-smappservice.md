# Studio Background Helper (SMAppService Option A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ONE Developer-ID-signed background helper to `ax studio.app` that owns the surreal + ax serve + ingest backend via launchd (SMAppService `agentService`), so the data plane survives the app being closed or crashing - without re-creating the rejected "unidentified developer bash" Login Items.

**Architecture:** Invert ownership. Today the UI app supervises surreal/serve as child processes that die with it (`AxBackendManager`). Instead, a launchd-managed **helper** (the same signed app binary launched with `--background-helper`, registered via `app.setLoginItemSettings({ type: 'agentService' })`, `RunAtLoad` + `KeepAlive`) owns the backend. The UI app's existing `AxDaemonArbitration` **attach** path then just connects to the already-running backend. Because the original failure was a *wedge* (alive-but-unresponsive surreal) and `KeepAlive` only restarts on exit, the helper also runs a **real-query watchdog** that force-restarts a hung db.

**Tech Stack:** Electron 41.5.0, Effect (`effect@beta`), Bun, `@effect/platform-node`, electron-builder, macOS SMAppService / `launchd`, SurrealDB.

**Resolves:** [#599](https://github.com/Necmttn/ax/issues/599). **Builds on / amends:** `docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md` (this is Option A, the pre-approved escape hatch, now required by the 4-day-stall incident in `memory/ax-data-plane-fragile-ide-model.md`).

## Global Constraints

- Electron version: **41.5.0** (no upgrade). `setLoginItemSettings({ type: 'agentService' })` is the API; `mainAppService` is already used for `openAtLogin` (`apps/studio-desktop/src/app/ElectronApp.ts:73`).
- **Helper form - DECIDED by spikes 1 + 1b (Form A):** the agent plist's `BundleProgram` is the **bundled `bun` Mach-O** (`Contents/Resources/bin/<arch>/bun`), with `ProgramArguments` running an **ax-src helper entry**. There is NO separate compiled helper binary (the main Electron binary can't be a launchd agent - needs WindowServer; and the compiled `axctl` binary can't live-ingest - lmdb won't bundle). The helper MUST run under bundled bun + ax-src. Runtime proven in `.superpowers/sdd/task-1b-microspike-report.md`.
- Helper serviceName == Label == plist filename: **`com.necmttn.ax-studio.helper`**. App id stays `com.necmttn.ax-studio`. Plist at `Contents/Library/LaunchAgents/com.necmttn.ax-studio.helper.plist`.
- Plist MUST NOT set `StandardOutPath`/`StandardErrorPath` (macOS 14.4+ rejects SMAppService jobs that do - `SMAppServiceErrorDomain` 22). The helper opens its own log file under `~/.local/share/ax/logs/`.
- `BundleProgram` is bundle-root-relative (launchd verifies the signature chain to the app's Team ID); never an absolute path.
- Bundle prerequisite: `stage-ax-source.ts` must `bun install` into the staged `ax-src/` (the shipped bundle currently has no `node_modules`, so bundled bun can't run ax-src). Folded into Task 4.
- Data dir is shared and singular: `$AX_DATA_DIR ?? ~/.local/share/ax`. Exactly ONE process owns surreal at a time - enforced by `AxDaemonArbitration` port probes. Never run two surreal on `:8521`.
- Ports: surreal `8521`, ax serve `1738` (`AxDaemonArbitration.ts:21-22`).
- `check:no-node-fs` gate bans `node:fs`/`node:path` in `apps/` - use Effect `FileSystem`/`Path` (see `findDesktopApp` pattern, `install.ts:86`).
- Headless CLI (`ax ingest`, `ax serve`, `ax daemon`) must stay functional and unchanged for non-desktop users.
- macOS-only feature. On non-darwin the helper registration is a no-op (guard on `process.platform === 'darwin'`).

---

### Task 1: Spike - pin the Electron `agentService` contract (de-risk)

**Why first:** the exact plist placement, the `serviceName`/`name` field, and whether Electron generates the plist or expects it pre-bundled are the only true unknowns. Everything else reuses existing modules. Resolve this before building.

**Files:**
- Create: `docs/superpowers/notes/2026-06-24-agentservice-contract.md` (findings)
- Reference: `apps/studio-desktop/src/app/ElectronApp.ts:60-80` (existing `setLoginItemSettings`)

- [ ] **Step 1: Read the Electron 41.5.0 docs for `setLoginItemSettings`** - focus on the macOS `type: 'agentService'` branch. Capture verbatim: required fields (`serviceName`? `name`?), where the agent plist must live in the bundle (`Contents/Library/LaunchAgents/<name>.plist` is the documented SMAppService location), what `BundleProgram` must be relative to, and whether `openAtLogin: true` is what enables it. Source: https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows

- [ ] **Step 2: Confirm the BundleProgram-as-main-binary pattern** is valid (launchd runs `…/Contents/MacOS/ax studio --background-helper`). If Electron requires a *separate* helper executable instead, record that as the fallback (a tiny `bun`-shebang launcher staged into the bundle) and which Task 4 variant to use.

- [ ] **Step 3: Write the contract note** - the exact plist XML shape, the exact `setLoginItemSettings` call args, the registration + `status` + unregister API (`getLoginItemSettings`, `serviceStatus`), and the chosen executable strategy. Every later task references this file.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/2026-06-24-agentservice-contract.md
git commit -m "docs: pin Electron agentService contract for studio helper (#599)"
```

**Gate:** if Step 2 reveals `agentService` cannot point at the main binary AND a bundled bun-launcher is also infeasible on a hardened-runtime/notarized build, STOP and escalate - the approach needs revisiting before more work.

---

### Task 2: `ax serve --managed-db` + `--ingest-every` (the helper runtime)

**Design (resolved by spikes 1+1b):** the helper plist runs bundled-`bun` against the bundled ax-src `serve` command. So the helper runtime IS `ax serve` with two new flags: `--managed-db` (spawn + supervise bundled surreal as a child, then serve) and `--ingest-every=<dur>` (fork an internal ingest loop). Bundle-location independence: `--managed-db` resolves the surreal binary as a **sibling of `process.execPath`** (bundled bun and surreal both live in `Contents/Resources/bin/<arch>/`), so no absolute paths in the plist. Both flags are also useful for non-desktop users (`ax serve --managed-db` = one-shot self-contained daemon).

**Files:**
- Create: `apps/axctl/src/dashboard/managed-db.ts` (resolve surreal path + spawn/supervise as a child, readiness-gated)
- Create: `apps/axctl/src/dashboard/serve-ingest-loop.ts` (interval loop calling the in-process ingest entry - the same `runIngest` the `POST /api/ingest` handler forks, NOT an HTTP round-trip)
- Modify: the `serve` command definition (find it: `rg -n "\"serve\"|serveCommand|cmdServe" apps/axctl/src/cli`) to add the two flags + wire them
- Test: `apps/axctl/src/dashboard/managed-db.test.ts`, `apps/axctl/src/dashboard/serve-ingest-loop.test.ts`

**Interfaces:**
- Consumes: existing serve bootstrap (`apps/axctl/src/dashboard/server.ts`), `@ax/lib/runtime-state` for the db host/port, the existing in-process ingest entry used by `POST /api/ingest` (locate via `rg -n "runIngest|/api/ingest" apps/axctl/src/dashboard`).
- Produces:
  - `export const resolveManagedSurrealPath: (execPath: string) => string` - sibling-of-execPath resolution (`<dir(execPath)>/surreal`).
  - `export const makeManagedDb: (opts: { surrealPath: string; host: string; port: number; dataDir: string }) => Effect.Effect<void, ManagedDbError, Scope.Scope | ChildProcessSpawner | HttpClient>` - spawns surreal, waits on `/health`, registers a scope finalizer that stops it.
  - `export const runIngestLoop: (opts: { every: Duration.Duration; sinceDays: number }) => Effect.Effect<void>` - `repeat(Schedule.spaced(every))`, fail-soft per iteration.
  - serve flags: `--managed-db` (boolean), `--ingest-every` (duration string e.g. `2m`, optional).

- [ ] **Step 1: Write the failing test** - `resolveManagedSurrealPath` returns the sibling path.

```typescript
import { describe, it, expect } from "bun:test";
import { resolveManagedSurrealPath } from "./managed-db.ts";

describe("resolveManagedSurrealPath", () => {
  it("resolves surreal as a sibling of the bun execPath", () => {
    expect(resolveManagedSurrealPath("/Applications/ax studio.app/Contents/Resources/bin/arm64/bun"))
      .toBe("/Applications/ax studio.app/Contents/Resources/bin/arm64/surreal");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/axctl && bun test src/dashboard/managed-db.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement `resolveManagedSurrealPath` + `makeManagedDb`** - use Effect `Path` to take `dirname(execPath)` and join `surreal`. `makeManagedDb` spawns via the existing `ChildProcessSpawner` pattern (mirror how the desktop's `SupervisedProcess`/the CLI spawns surreal; reuse the surreal arg shape from `apps/axctl/src/cli/install.ts:108-110` - `start --user root --pass root --bind host:port --log info --allow-experimental=files "rocksdb://<dataDir>/db"`), waits for `GET http://host:port/health`, and adds a `Scope` finalizer that SIGTERMs (then SIGKILLs) the child.

- [ ] **Step 4: Implement `runIngestLoop`** - fork the in-process ingest entry on `Schedule.spaced(every)`, each iteration `Effect.catchCause`-logged (fail-soft; one bad run never kills the loop).

- [ ] **Step 5: Wire the flags into `serve`** - when `--managed-db`, run `makeManagedDb` (scoped) BEFORE binding the HTTP server, so surreal is ready first; when `--ingest-every` is set, `Effect.forkScoped(runIngestLoop(...))` after serve is up. Default values: `--ingest-every` unset = no loop (preserve current behavior). Existing `ax serve` with neither flag is byte-for-byte unchanged.

- [ ] **Step 6: Run tests + a real local smoke on a TEST port** (never 8521 / the live db).

Run: `cd apps/axctl && bun test src/dashboard/ && AX_DATA_DIR=/tmp/ax-mdb-smoke bun src/cli/index.ts serve --managed-db --port=8531 --ingest-every=2m` then `curl -s 127.0.0.1:8531/api/version`; Ctrl-C and confirm the child surreal is reaped.
Expected: tests pass; `/api/version` answers; no orphan surreal after exit.

- [ ] **Step 7: Commit**

```bash
git add apps/axctl/src/dashboard/managed-db.ts apps/axctl/src/dashboard/serve-ingest-loop.ts apps/axctl/src/dashboard/managed-db.test.ts apps/axctl/src/dashboard/serve-ingest-loop.test.ts
git add -p   # the serve command file
git commit -m "feat(serve): --managed-db (supervise surreal child) + --ingest-every loop (#599)"
```

**Note for Task 3 (watchdog) + Task 6 (UI arbitration):** the wedge watchdog (Task 3) forks inside the `--managed-db` path here (it owns the surreal child it must restart). The UI app does NOT use `--managed-db`; it keeps `AxBackendManager` attach-mode and connects to the helper's serve (Task 6).

---

### Task 3: Surreal wedge watchdog (the incident fix)

**Why:** the 4-day stall was a *wedge* - surreal held the LISTEN socket but stopped answering. `KeepAlive` never fires (no exit). The helper must detect unresponsiveness via a real query and force-restart.

**Files:**
- Create: `apps/studio-desktop/src/backend/SurrealWatchdog.ts`
- Modify: `apps/studio-desktop/src/backend/AxBackendManager.ts` (fork the watchdog after surreal-ready in spawn mode; expose a restart hook)
- Test: `apps/studio-desktop/src/backend/SurrealWatchdog.test.ts`

**Interfaces:**
- Consumes: `HttpClient.HttpClient`; a `restartSurreal: Effect.Effect<void>` callback (the manager already owns the `SupervisedProcess` for surreal - expose its `stop`+`start`, or reuse the supervisor restart). Surreal liveness must be a real query, NOT `/health` (the wedge passed socket checks). Use `POST http://127.0.0.1:8521/sql` with `SELECT 1` (authenticated) and a hard per-probe timeout.
- Produces: `export const makeSurrealWatchdog: (opts: { probe: Effect.Effect<boolean>; onWedged: Effect.Effect<void>; interval: Duration.Duration; failuresToTrip: number }) => Effect.Effect<void>` (an infinite forked loop).

- [ ] **Step 1: Write the failing test** - N consecutive failed probes trips exactly one `onWedged`; a success resets the counter.

```typescript
import { describe, it, expect } from "bun:test";
import { Effect, Duration, Ref, TestClock, TestContext } from "effect";
import { makeSurrealWatchdog } from "./SurrealWatchdog.ts";

describe("SurrealWatchdog", () => {
  it("trips onWedged after failuresToTrip consecutive failures", () =>
    Effect.gen(function* () {
      const trips = yield* Ref.make(0);
      yield* Effect.fork(makeSurrealWatchdog({
        probe: Effect.succeed(false), // always wedged
        onWedged: Ref.update(trips, (n) => n + 1),
        interval: Duration.seconds(5),
        failuresToTrip: 3,
      }));
      yield* TestClock.adjust(Duration.seconds(15)); // 3 ticks → 1 trip
      expect(yield* Ref.get(trips)).toBe(1);
    }).pipe(Effect.provide(TestContext.TestContext), Effect.runPromise));
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/studio-desktop && bun test src/backend/SurrealWatchdog.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Implement the watchdog** - a `Ref`-counter loop on `Schedule.spaced(interval)`: probe; on success reset counter to 0; on failure increment; when counter reaches `failuresToTrip`, run `onWedged` and reset counter (so it re-arms after the restart). Pure w.r.t. clock (TestClock-drivable).

- [ ] **Step 4: Wire into the `--managed-db` path (Task 2)** - inside `makeManagedDb` (`apps/axctl/src/dashboard/managed-db.ts`), after the surreal child is ready, `Effect.forkScoped` a `makeSurrealWatchdog` whose `probe` does a real `SELECT 1` round-trip (1s timeout) and whose `onWedged` force-restarts the managed surreal child (SIGKILL the wedged pid - recall SIGTERM was ignored in the incident - then re-spawn). Add a structured log line on trip. NOTE: this lives only in `--managed-db` (the helper owns surreal); the UI app runs attach-mode and never starts the watchdog. **Files for this task are therefore `apps/axctl/src/dashboard/SurrealWatchdog.ts` (+ `.test.ts`), not studio-desktop** - run tests with `cd apps/axctl && bun test src/dashboard/SurrealWatchdog.test.ts`, and the commit adds `apps/axctl/src/dashboard/SurrealWatchdog*.ts` + `managed-db.ts`.

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/studio-desktop && bun test src/backend/SurrealWatchdog.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/studio-desktop/src/backend/SurrealWatchdog.ts apps/studio-desktop/src/backend/SurrealWatchdog.test.ts apps/studio-desktop/src/backend/AxBackendManager.ts
git commit -m "feat(studio-desktop): real-query surreal wedge watchdog + force-restart (#599)"
```

---

### Task 4: Bundle the agent plist + place the helper program (electron-builder)

**Files:**
- Create: `apps/studio-desktop/build/LaunchAgents/com.necmttn.ax-studio.helper.plist` (Form A plist - `BundleProgram` = bundled bun, `ProgramArguments` = ax-src serve entry)
- Modify: `apps/studio-desktop/electron-builder.config.cjs` (`extraFiles` placing the plist at `Contents/Library/LaunchAgents/`)
- Modify: `apps/studio-desktop/scripts/stage-ax-source.ts` (run `bun install --production` in the staged `ax-src/` so bundled bun can resolve ax-src deps - the shipped bundle currently has no `node_modules`; this is the spike-1b blocker)
- Test: `apps/studio-desktop/scripts/verify-helper-bundle.test.ts` (asserts the staged tree has the plist with the right keys)

**Interfaces (Form A - from `docs/superpowers/notes/2026-06-24-agentservice-contract.md`):**
- `BundleProgram` = `Contents/Resources/bin/${arch}/bun` (the bundled, app-signed bun Mach-O; bundle-root-relative).
- `ProgramArguments` = `[ "ax-src/apps/axctl/src/cli/index.ts", "serve", "--managed-db", "--port=1738", "--ingest-every=2m" ]` - bun runs the bundled ax-src serve entry with the Task-2 flags. (Path is relative to the bundle; bun resolves it from its own `process.execPath` location. Confirm the exact relative form against the staged tree.)
- `Label` == `com.necmttn.ax-studio.helper` (== filename == serviceName). `KeepAlive`=true, `RunAtLoad`=true, `ProcessType`=Background, `AssociatedBundleIdentifiers`=[`com.necmttn.ax-studio`].
- **NO `StandardOutPath`/`StandardErrorPath`** (macOS 14.4+ rejects them on SMAppService jobs - the helper opens its own log under `~/.local/share/ax/logs/`).

- [ ] **Step 1: Write the failing test** - given the plist path, assert it parses (`plutil -convert json`) and has: `Label == com.necmttn.ax-studio.helper`, `BundleProgram` ending `/bin/<arch>/bun`, `ProgramArguments` containing `serve` + `--managed-db`, `RunAtLoad == true`, a truthy `KeepAlive`, and **NO `StandardOutPath`/`StandardErrorPath` keys**.

```typescript
import { describe, it, expect } from "bun:test";
import { parseHelperPlist } from "./verify-helper-bundle.ts"; // plutil -convert json wrapper
// asserts the keys above from build/LaunchAgents/com.necmttn.ax-studio.helper.plist
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/studio-desktop && bun test scripts/verify-helper-bundle.test.ts`
Expected: FAIL - plist absent.

- [ ] **Step 3: Author the plist** at `build/LaunchAgents/com.necmttn.ax-studio.helper.plist` using the verbatim Form A shape in the contract note (§3 + §4). Mirror only the `KeepAlive`/`SoftResourceLimits NumberOfFiles 65536`/`ThrottleInterval 5` headroom from the CLI's `dbPlist` (`apps/axctl/src/cli/install.ts:96-157`). Do NOT include `StandardOutPath`/`StandardErrorPath`.

- [ ] **Step 4: Wire electron-builder + the bundle deps** - (a) add an `extraFiles` entry copying the plist to `Library/LaunchAgents/com.necmttn.ax-studio.helper.plist` (`to` is relative to `Contents/`); (b) update `stage-ax-source.ts` to `bun install` the staged `ax-src/` so bundled bun can run it. electron-builder auto-signs all Mach-Os in the bundle (bun included) under `hardenedRuntime: true` - confirm `entitlementsInherit` covers the bundled bun (it already runs as a child today).

- [ ] **Step 5: Run the bundle test against a staged build, verify pass**

Run: `cd apps/studio-desktop && bun run build && bun test scripts/verify-helper-bundle.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/studio-desktop/build/com.necmttn.ax-studio-helper.plist apps/studio-desktop/electron-builder.config.cjs apps/studio-desktop/scripts/verify-helper-bundle.*
git commit -m "build(studio-desktop): bundle signed ax-studio-helper LaunchAgent plist (#599)"
```

---

### Task 5: Register / enable / unregister the helper (SMAppService)

**Files:**
- Modify: `apps/studio-desktop/src/app/ElectronApp.ts` (add `registerBackgroundHelper` / `unregisterBackgroundHelper` / `helperStatus` to the `ElectronApp` service)
- Modify: `apps/studio-desktop/src/app/DesktopApp.ts:87-96` (call register on prod startup, alongside/instead of the current `setOpenAtLogin`)
- Test: `apps/studio-desktop/src/app/ElectronApp.test.ts` (verify the `setLoginItemSettings` args via a stub Electron)

**Interfaces:**
- Consumes: Task 1's exact `setLoginItemSettings({ type: 'agentService', serviceName: 'com.necmttn.ax-studio-helper', openAtLogin: true })` arg shape; `app.getLoginItemSettings({ type:'agentService', serviceName })` for status.
- Produces: `ElectronApp.registerBackgroundHelper: Effect.Effect<void>`, `ElectronApp.unregisterBackgroundHelper: Effect.Effect<void>`, `ElectronApp.helperStatus: Effect.Effect<"enabled"|"requiresApproval"|"notRegistered"|"notFound">`.

- [ ] **Step 1: Write the failing test** - `registerBackgroundHelper` calls the Electron stub's `setLoginItemSettings` exactly once with `type: 'agentService'` and the helper `serviceName`; guarded to no-op off darwin.

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/studio-desktop && bun test src/app/ElectronApp.test.ts`
Expected: FAIL - method missing.

- [ ] **Step 3: Implement** the three methods on `ElectronApp` (mirror the existing `setOpenAtLogin` wrapper at line 73). Guard `process.platform === 'darwin'`; fail-soft (log + continue) like the current `setOpenAtLogin` call.

- [ ] **Step 4: Call on startup** - in `DesktopApp.ts` prod-only startup block, replace the bare `setOpenAtLogin(true)` with `registerBackgroundHelper` (which both registers the agent and keeps the app's own Login Item behavior per Task 1's findings). If `helperStatus` returns `requiresApproval`, surface a one-time tray/notification nudge (System Settings → Login Items). Keep it fail-soft - registration failure must never block the UI.

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/studio-desktop && bun test src/app/ElectronApp.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/studio-desktop/src/app/ElectronApp.ts apps/studio-desktop/src/app/ElectronApp.test.ts apps/studio-desktop/src/app/DesktopApp.ts
git commit -m "feat(studio-desktop): register ax-studio-helper via SMAppService agentService (#599)"
```

---

### Task 6: UI attaches to the helper-owned backend (no double-spawn)

**Files:**
- Modify: `apps/studio-desktop/src/backend/AxDaemonArbitration.ts` (ensure a healthy helper backend → `attach`)
- Modify: `apps/studio-desktop/src/backend/AxBackendManager.ts:542-575` (attach path: do not spawn, do not run the watchdog; the helper owns both)
- Test: `apps/studio-desktop/src/backend/AxDaemonArbitration.test.ts`

**Interfaces:**
- Consumes: existing `decideArbitration` (`AxDaemonArbitration.ts:54-59`) returning `"attach" | "spawn" | "spawn-ax-only" | "conflict"`; probes `probeDaemon` (`/api/version`), `probeSurreal` (`/health`).
- Produces: unchanged decision type. New invariant: when the helper's serve+surreal are healthy, the UI resolves to `attach` and never spawns.

- [ ] **Step 1: Write the failing/pinning test** - when both `probeDaemon` and `probeSurreal` are healthy, `decideArbitration` returns `"attach"` (covers the helper-already-running case the UI now hits on every launch).

```typescript
// daemonHealthy=true, surrealHealthy=true, portsFree=false → "attach"
```

- [ ] **Step 2: Run it**

Run: `cd apps/studio-desktop && bun test src/backend/AxDaemonArbitration.test.ts`
Expected: this may already pass (`daemonHealthy → "attach"`). The test pins the invariant regardless; proceed to Step 3.

- [ ] **Step 3: Verify/adjust the manager attach path** - in `AxBackendManager` attach mode, confirm it opens the window + polls readiness but spawns NO surreal/serve and forks NO `SurrealWatchdog` (Task 3 must be spawn-mode-only). Add a manager-level test if one does not exist.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/studio-desktop && bun test src/backend/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/studio-desktop/src/backend/
git commit -m "feat(studio-desktop): UI attaches to helper-owned backend, no double-spawn (#599)"
```

---

### Task 7: Real-query health in `ax daemon status` + doctor (visibility follow-up)

**Why:** during the incident `ax daemon status`/`doctor` reported `database: listening on :8521` because they check the socket, not a query. A wedge must be visible.

**Files:**
- Modify: `apps/axctl/src/cli/install.ts:772-843` (`collectDaemonEndpoint` / `collectDaemonStatus` / `formatDaemonStatus`)
- Reference: `@ax/lib/db` for a minimal authenticated `SELECT 1` round-trip
- Test: `apps/axctl/src/cli/install.test.ts` (or the nearest existing daemon-status test) - status maps a socket-up-but-query-timeout db to a distinct `wedged` state.

**Interfaces:**
- Consumes: existing `probePort` (socket) + a new `probeDbQuery(host, port): Effect.Effect<boolean>` (real `SELECT 1`, short timeout).
- Produces: status output distinguishes `listening (healthy)` from `listening but NOT answering queries (wedged) - restart with 'ax daemon restart'`.

- [ ] **Step 1: Write the failing test** - `formatDaemonStatus` with `{ portListening: true, queryOk: false }` includes the word `wedged` and the restart hint.

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/axctl && bun test src/cli/install.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `probeDbQuery` (reuse `@ax/lib/db` connect + `SELECT 1`, 1–2s timeout, fail-closed) and fold its result into `collectDaemonStatus`; add the `wedged` line in `formatDaemonStatus`.

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/axctl && bun test src/cli/install.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/axctl/src/cli/install.ts apps/axctl/src/cli/install.test.ts
git commit -m "feat(daemon): status/doctor flag a wedged db via real SELECT 1 probe (#599)"
```

---

### Task 8: Build, sign, notarize, and document

**Files:**
- Modify: `.github/workflows/studio-desktop-release.yml` (verify the bundled plist is signed inside the app)
- Modify: `apps/studio-desktop/README.md` (or the desktop docs) - helper model, how to verify, how to uninstall (SMAppService unregister)
- Modify: `docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md` - flip Option A from "rejected/escape hatch" to "implemented (#599)" with a back-reference to this plan and the incident memory.

- [ ] **Step 1: Local signed-build smoke** - produce a signed (or ad-hoc) build, install to `/Applications`, launch, quit the app, and confirm: surreal+serve still answer (`curl :1738/api/version`), the agent shows in `launchctl list | rg ax-studio-helper` with exit 0, and `kill -9` of surreal triggers a respawn within `ThrottleInterval`.

- [ ] **Step 2: Wedge-recovery smoke (incident regression)** - simulate a wedge (`kill -STOP <surreal-pid>`), confirm the watchdog trips within `failuresToTrip * interval` and force-restarts (`kill -9` + respawn), and queries recover.

- [ ] **Step 3: Login Item attribution check** - on a signed build, confirm System Settings → General → Login Items shows ONE "ax studio" item attributed to the Developer ID (NOT "bash - unidentified developer"). This is the acceptance criterion distinguishing Option A from the rejected Option B.

- [ ] **Step 4: Docs + spec flip + commit**

```bash
git add apps/studio-desktop/README.md docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md
git commit -m "docs: ship Option A studio background helper; flip spec + uninstall notes (#599)"
```

- [ ] **Step 5: Tag a release dry-run** (or document the exact secrets/steps if CI secrets are not yet configured - `CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

---

## Self-Review

**Spec coverage (vs #599 acceptance criteria):**
- "Quitting/force-killing the app leaves db running + queryable" → Tasks 2,4,5 (helper owns backend via launchd) + Task 8 Step 1.
- "kill -9 the db triggers respawn (KeepAlive)" → Task 4 (KeepAlive) + Task 8 Step 1.
- "db comes up at login without opening the app (RunAtLoad)" → Task 4 (RunAtLoad) + Task 5 (register).
- "ax daemon status reflects the registered service" → Task 7.
- "clean unregister on uninstall" → Task 5 (`unregisterBackgroundHelper`) + Task 8 docs.
- Beyond #599: wedge detection (Task 3) - the actual incident root cause that KeepAlive alone would miss; and the false-"listening" visibility gap (Task 7).

**Placeholder scan:** Task 1 is a deliberate spike (the one true unknown - Electron `agentService` exact contract) that gates the executable-strategy choice for Tasks 2/4; its output is a concrete note, not a deferral. No "TODO/handle edge cases" left in implementation steps.

**Type consistency:** `isHelperInvocation`/`helperProgram` (Task 2), `makeSurrealWatchdog` opts (Task 3), `registerBackgroundHelper`/`unregisterBackgroundHelper`/`helperStatus` (Task 5), `decideArbitration` return union (Task 6), `probeDbQuery` (Task 7) - names are used consistently across the tasks that reference them.

**Known risks:** (1) Task 1 could invalidate the single-binary `--background-helper` assumption (forcing a separate bundled launcher); the gate in Task 1 catches this before downstream work. (2) `agentService` may require user approval in System Settings on first run (handled as a fail-soft tray nudge in Task 5 Step 4), unlike a loose LaunchAgent - an acceptable trade for Developer-ID attribution.
