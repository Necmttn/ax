# Studio Background Helper (SMAppService Option A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ONE Developer-ID-signed background helper to `ax studio.app` that owns the surreal + ax serve + ingest backend via launchd (SMAppService `agentService`), so the data plane survives the app being closed or crashing - without re-creating the rejected "unidentified developer bash" Login Items.

**Architecture:** Invert ownership. Today the UI app supervises surreal/serve as child processes that die with it (`AxBackendManager`). Instead, a launchd-managed **helper** (the same signed app binary launched with `--background-helper`, registered via `app.setLoginItemSettings({ type: 'agentService' })`, `RunAtLoad` + `KeepAlive`) owns the backend. The UI app's existing `AxDaemonArbitration` **attach** path then just connects to the already-running backend. Because the original failure was a *wedge* (alive-but-unresponsive surreal) and `KeepAlive` only restarts on exit, the helper also runs a **real-query watchdog** that force-restarts a hung db.

**Tech Stack:** Electron 41.5.0, Effect (`effect@beta`), Bun, `@effect/platform-node`, electron-builder, macOS SMAppService / `launchd`, SurrealDB.

**Resolves:** [#599](https://github.com/Necmttn/ax/issues/599). **Builds on / amends:** `docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md` (this is Option A, the pre-approved escape hatch, now required by the 4-day-stall incident in `memory/ax-data-plane-fragile-ide-model.md`).

## Global Constraints

- Electron version: **41.5.0** (no upgrade). `setLoginItemSettings({ type: 'agentService' })` is the API; `mainAppService` is already used for `openAtLogin` (`apps/studio-desktop/src/app/ElectronApp.ts:73`).
- One signed binary: the helper is the **main app executable** invoked with `--background-helper`. Do NOT introduce a second executable to sign.
- Helper label: **`com.necmttn.ax-studio-helper`**. App id stays `com.necmttn.ax-studio`. Plist bundled at `Contents/Library/LaunchAgents/com.necmttn.ax-studio-helper.plist`.
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

### Task 2: Headless backend entry (`--background-helper`)

**Files:**
- Create: `apps/studio-desktop/src/helper/program.ts` (headless Effect program)
- Modify: `apps/studio-desktop/src/main.ts:115-126` (arg branch before UI composition)
- Test: `apps/studio-desktop/src/helper/program.test.ts`

**Interfaces:**
- Consumes: `AxBackendManager` (`AxBackendManagerShape { start, stop, snapshot }`, `AxBackendManager.liveLayer`, `backend/AxBackendManager.ts:258-672`); `DesktopIngestScheduler.run(config)` (`backend/DesktopIngestScheduler.ts:54`); `DesktopEnvironment` layer (`app/DesktopEnvironment.ts`); Node platform + `HttpClient` layers (`main.ts:75-83`).
- Produces: `export const helperProgram: Effect.Effect<void, never, never>` (fully provided at the entry) and `export const isHelperInvocation: (argv: readonly string[]) => boolean`.

- [ ] **Step 1: Write the failing test** - `isHelperInvocation` detects the flag and nothing else.

```typescript
import { describe, it, expect } from "bun:test";
import { isHelperInvocation } from "./program.ts";

describe("isHelperInvocation", () => {
  it("true when --background-helper present", () => {
    expect(isHelperInvocation(["node", "app", "--background-helper"])).toBe(true);
  });
  it("false for a normal UI launch", () => {
    expect(isHelperInvocation(["node", "app"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/studio-desktop && bun test src/helper/program.test.ts`
Expected: FAIL - `isHelperInvocation` not exported.

- [ ] **Step 3: Implement the headless program**

`apps/studio-desktop/src/helper/program.ts` - compose ONLY the backend layers (NO `electronLayer`, window, tray, protocol, menu). Reuse `AxBackendManager.liveLayer`, the `DesktopEnvironment` layer, Node platform services, `HttpClient`. The program: `backendManager.start` → `Effect.forkScoped(DesktopIngestScheduler.run({ sinceDays: 7, interval: Duration.minutes(2) }))` → block forever (`Effect.never`) inside a `Scope` whose finalizer calls `backendManager.stop({ timeout: Duration.seconds(6) })`. Handle SIGTERM/SIGINT → interrupt the scope (launchd sends SIGTERM on unload). Mirror the scoped-program shape in `app/DesktopApp.ts:130-166` but drop every UI concern.

```typescript
export const isHelperInvocation = (argv: readonly string[]): boolean =>
  argv.includes("--background-helper");

// helperProgram: backend.start; fork ingest loop; Effect.never; scope finalizer stops backend.
// Provide: AxBackendManager.liveLayer + DesktopEnvironment.layer + NodeServices + HttpClient.
```

- [ ] **Step 4: Branch the entry in `main.ts`** - BEFORE the Electron single-instance lock + UI layer composition (`main.ts:115`), check `isHelperInvocation(process.argv)`. If true, run `helperProgram.pipe(NodeRuntime.runMain)` and return - never touch `electronLayer`/`app.whenReady`. Keep `requestSingleInstanceLock` only on the UI path. (The helper and UI are separate launchd/GUI processes; the helper must not grab the GUI single-instance lock.)

- [ ] **Step 5: Run the test, verify pass**

Run: `cd apps/studio-desktop && bun test src/helper/program.test.ts`
Expected: PASS.

- [ ] **Step 6: Manual smoke (dev)** - ad-hoc-sign the bundled binaries if needed, then run the built main binary with the flag and confirm surreal+serve come up and `curl 127.0.0.1:1738/api/version` answers, with NO Electron window.

Run: `cd apps/studio-desktop && bun run dist-electron/main.cjs --background-helper` (dev entry) - observe backend logs, then `curl -s 127.0.0.1:1738/api/version`.
Expected: JSON version response; no window.

- [ ] **Step 7: Commit**

```bash
git add apps/studio-desktop/src/helper/ apps/studio-desktop/src/main.ts
git commit -m "feat(studio-desktop): headless --background-helper backend entry (#599)"
```

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

- [ ] **Step 4: Wire into `AxBackendManager`** - after surreal readiness in spawn mode (`AxBackendManager.ts:427` region), `Effect.forkScoped` a `makeSurrealWatchdog` whose `probe` does a real `SELECT 1` round-trip (1s timeout) and whose `onWedged` force-restarts the surreal `SupervisedProcess` (SIGKILL the wedged pid - recall SIGTERM was ignored in the incident - then supervisor respawns). Add a structured log line on trip. Skip the watchdog in `attach` mode (the helper, not the UI, owns surreal).

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
- Create: `apps/studio-desktop/build/com.necmttn.ax-studio-helper.plist` (template; `BundleProgram` + `--background-helper`, `RunAtLoad`, `KeepAlive`)
- Modify: `apps/studio-desktop/electron-builder.config.cjs` (`extraFiles` to place the plist at `Contents/Library/LaunchAgents/`)
- Test: `apps/studio-desktop/scripts/verify-helper-bundle.test.ts` (asserts the built/staged tree has the plist at the right path with the right keys)

**Interfaces:**
- Consumes: the exact plist shape + path from Task 1's contract note; the KeepAlive/limits shape from the CLI's `dbPlist` (`apps/axctl/src/cli/install.ts:96-157`) - mirror `KeepAlive { SuccessfulExit:false, Crashed:true }`, `SoftResourceLimits NumberOfFiles 65536`, `ThrottleInterval 5`. NOTE: the bundled plist's `ProgramArguments` is the helper binary (NOT a `/bin/bash -lc` - that's the whole point: a Developer-ID-attributed item, not "bash unidentified").
- Produces: a packaged app whose `Contents/Library/LaunchAgents/com.necmttn.ax-studio-helper.plist` `BundleProgram` resolves to the signed main executable.

- [ ] **Step 1: Write the failing test** - given a staged app tree path, assert the plist exists at `Contents/Library/LaunchAgents/com.necmttn.ax-studio-helper.plist`, parses, has `Label == com.necmttn.ax-studio-helper`, `RunAtLoad == true`, a `KeepAlive` dict, and `BundleProgram`/`ProgramArguments` referencing `--background-helper`.

```typescript
import { describe, it, expect } from "bun:test";
import { parseHelperPlist } from "./verify-helper-bundle.ts"; // plutil -convert json wrapper
// asserts the four keys above from build/com.necmttn.ax-studio-helper.plist
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/studio-desktop && bun test scripts/verify-helper-bundle.test.ts`
Expected: FAIL - plist absent.

- [ ] **Step 3: Author the plist** (`build/com.necmttn.ax-studio-helper.plist`) per Task 1's contract - `Label`, `ProgramArguments` = `[<MacOS/ax studio>, --background-helper]` (or `BundleProgram` form Electron requires), `RunAtLoad true`, `KeepAlive { SuccessfulExit false, Crashed true }`, `SoftResourceLimits NumberOfFiles 65536`, `ThrottleInterval 5`, `StandardOutPath`/`StandardErrorPath` under `~/.local/share/ax/logs/`.

- [ ] **Step 4: Wire electron-builder** - add to `electron-builder.config.cjs` `mac` config an `extraFiles` entry copying the plist into `Contents/Library/LaunchAgents/`. Confirm `hardenedRuntime: true` + existing entitlements (`build/entitlements.mac.plist`) sign the plist's target (the main binary already gets signed). No new entitlement needed (helper reuses the app's; `allow-dyld-environment-variables` already present for spawning surreal/bun).

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
