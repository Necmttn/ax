# Studio desktop - background/daemon model (decided: IDE model → Option A implemented)

> **UPDATE 2026-06-24 (#599):** Option A is now **IMPLEMENTED**. A 4-day
> data-plane stall (see `memory/ax-data-plane-fragile-ide-model.md`) made
> true app-closed capture a hard requirement; the IDE model's "app must be
> open" accepted tradeoff was no longer acceptable. Option A (SMAppService
> `agentService` helper) ships in #599 as the background daemon.
> Implementation plan: `docs/superpowers/plans/2026-06-24-studio-helper-smappservice.md`.
> Operator guide: see the "Operating the helper" section below.
> Original Option C decision rationale is preserved intact below.

**Date:** 2026-06-16
**Status (original):** Decided - **Option C (IDE model)**. Background-daemon options (A/B) rejected.
**Status (current):** **Option A implemented** via #599 (2026-06-24). Option C IDE-model code remains in place; the helper augments it - the UI app attaches to the already-running helper backend rather than spawning its own.
**Decision owner:** Necmttn
**Builds on:** `docs/superpowers/specs/2026-06-07-studio-desktop-design.md`

## Problem

`ax install` drops **five** loose `/bin/bash -lc` LaunchAgents into
`~/Library/LaunchAgents` (db / watch / derive-daily / quota-refresh / serve,
`apps/axctl/src/cli/install.ts`). macOS **Login Items & Extensions** lists each,
attributes `ProgramArguments[0]` = `/bin/bash`, and groups loose user LaunchAgents
under "unidentified developer" → **5 anonymous "bash - Item from unidentified
developer" background items** after install. A real user (Roland) flagged it as
looking like malware.

## How Electron IDEs actually do it (evidence)

Checked the reference we mirror, `.references/t3code` (pingdotgg/t3code), plus the
general VS Code / Electron-IDE pattern:

- **No `setLoginItemSettings`, no `SMAppService`, no `LaunchAgent`, no
  `openAtLogin`** anywhere in t3code (grep-empty).
- `DesktopApp.ts`: `backendManager.start` on `electronApp.whenReady`;
  `backendManager.stop()` on `before-quit`. **The backend child process lives and
  dies with the app window.**
- IDEs touch files freely (read/write the workspace) - but **only while the app is
  open**. Continuity is not a background daemon; it is the app being open (and,
  optionally, auto-launched at login + tray-resident).

Conclusion: a background login-item daemon is **not** the norm for this class of
app. The norm is "app owns its backend while running."

## Decision - Option C (IDE model)

1. The desktop app supervises **surreal + `ax serve` + ingest** only while open -
   already built via `AxBackendManager` + `AxDaemonArbitration`.
2. `ax install` **stops installing the 5 loose LaunchAgents** when the desktop app
   owns the lifecycle, and **migrates** (unload + remove) any pre-existing ones on
   first desktop launch. The 5 "bash unidentified" items then simply never exist -
   the problem is dissolved, not relocated.
3. Continuity / "always-on" = **`openAtLogin` on the main app** (`mainAppService`,
   one Login Item attributed to the Developer ID "ax studio"), optionally launched
   hidden + **tray/menubar-resident**. One signed item that *is* the app - not a
   separate bash agent.
4. Ingest catches up cheaply on launch/foreground via `ax ingest --since=N`,
   guarded by the existing ingest-lock (overlapping runs skip).

### Accepted tradeoff

Ingest does **not** run while the app is fully quit. Mitigated by auto-launch +
tray residence (effectively always-on for anyone who opts in). If true 24/7
app-closed capture ever becomes a hard requirement, revisit Option A below.

## Rejected alternatives

- **A - headless SMAppService helper daemon (5→1 background agent).** One bundled
  `agentService` plist (`BundleProgram`, registered via
  `setLoginItemSettings({ type: 'agentService', serviceName })`, verified available
  in Electron 41.5.0) running a headless `AxBackendManager` + polled ingest.
  Delivers true app-closed ingest as a single Developer-ID item. **Originally
  rejected for v0** (most work, not the IDE norm, unnecessary once auto-launch +
  tray). **NOW IMPLEMENTED via #599 (2026-06-24)** - the 4-day data-plane stall
  (IDE model; surreal wedge + app crash; `KeepAlive` alone can't fix a wedge) made
  24/7 app-closed capture a hard requirement. Form A: `BundleProgram` = bundled bun
  Mach-O (`Contents/Resources/bin/arm64/bun`); `ProgramArguments` run bundled ax-src
  serve entry with `--managed-db --ingest-every=2m`. Helper registered at app boot;
  KeepAlive+RunAtLoad in the plist; UI attaches via `AxDaemonArbitration`. A
  real-query watchdog SIGKILLs+respawns a hung surreal (the wedge fix KeepAlive
  alone can't provide). `ax daemon status` surfaces a wedged db;
  `ax daemon restart` triggers recovery.
- **B - bundle the existing agents as SMAppService agents.** 2–3 attributed items
  instead of 5. **Rejected:** still more background items than C, more moving parts.

## Implementation scope (Option C)

- **P1 - Tray + auto-launch.** ✅ CORE LANDED: `openAtLogin` via
  `mainAppService` (ElectronApp.setOpenAtLogin), registered on prod startup -
  the app is ONE Developer-ID Login Item. ⏳ REMAINING (design-gated): the
  visible menubar tray UI (icon asset + Open/Quit/toggle menu) + auto-launch
  default UX. Verify the Login Item renders as "ax studio" on a signed build.
- **P2 - Ingest while open.** ✅ LANDED: `DesktopIngestScheduler` fires an
  immediate ingest then every 2 min via the running serve's `POST /api/ingest`
  (ingest-lock dedupes); self-healing loop; forked into the program scope.
- **P3 - `install.ts` desktop-awareness.** Detect the installed `ax studio.app`
  (`findDesktopApp`, landed); skip writing the 5 loose plists; migrate (unload +
  remove) any pre-existing ones. Headless CLI (`ax ingest`, manual `ax serve`)
  stays functional.
  - **DECIDED (2026-06-16): desktop applies the schema on boot (option 1).** Only
    `cmdInstall` applied the SurrealDB schema before (`surreal import` against a
    running DB); neither `ax serve` nor the desktop supervisor did. Decision: the
    desktop becomes self-sufficient - after surreal is ready and before `ax serve`
    spawns, `AxBackendManager` applies the embedded `@ax/schema` `schema.surql`
    (bucket BACKEND paths rewritten to this machine's buckets dir via
    `renderBucketBackends`, mirroring `cmdInstall`) by running the bundled
    `surreal import` through `ChildProcessSpawner`. THEN P3's skip+migrate wiring
    in `cmdInstall` becomes safe (the app owns surreal + schema + serve end to
    end). Requires adding `@ax/schema` as a studio-desktop dep.
    - Sub-steps: **P3a** ✅ desktop schema-on-boot (`DesktopSchema` + wired
      between surreal-ready and serve-spawn; bucket allowlist on surreal config);
      **P3b** ✅ `cmdInstall` skip+migrate when `findDesktopApp()` is truthy.
- **P4 - CI release.** ✅ LANDED: `.github/workflows/studio-desktop-release.yml`
  per-arch matrix (arm64/macos-14, x64/macos-13 - host-arch native deps force
  per-arch builds) → sign (Developer ID `CSC_LINK`) → notarize (`APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`) → `--publish always`. Needs the
  secrets configured + a real tagged run to fully validate.

## Open questions

1. **Quota in-app.** `ax quota` reads the OAuth token from the macOS Keychain via
   `security`. In-app (signed, user session) this should work; confirm the
   hardened-runtime entitlements permit Keychain access, else fall back to
   `~/.claude/.credentials.json`.
2. **TCC / full-disk.** Reading `~/.claude`, `~/.codex` may trip macOS TCC on
   first access; t3code has a permission-loop fix worth lifting before release.

## Not doing (v0)

~~Headless background daemon (Option A)~~ (now implemented via #599), Windows/Linux
services (separate systemd track), root `daemonService`.

---

## Operating the helper (added 2026-06-24, #599)

The background helper (`com.necmttn.ax-studio.helper`) is an `agentService` launchd
job registered by `ax studio.app` at first launch via `setLoginItemSettings({ type:
'agentService', serviceName: 'com.necmttn.ax-studio.helper', openAtLogin: true })`.
It runs bundled bun → bundled ax-src `ax serve --managed-db --ingest-every=2m`,
keeping surreal + the HTTP API on `:1738` alive even when the UI app is closed or
crashes. A real-query watchdog inside the helper SIGKILLs+respawns a hung surreal
process (the original 4-day-stall scenario that `KeepAlive` alone cannot fix).

### What the helper does

- Owns surreal on `127.0.0.1:8521` (spawns it as a child via `--managed-db`).
- Owns `ax serve` on `127.0.0.1:1738` (the same HTTP API `ax studio.app` talks to).
- Runs an ingest loop every 2 minutes (`--ingest-every=2m`) so the graph stays
  current even when the app is closed.
- Survives app quit and crashes (launchd `KeepAlive`+`RunAtLoad`).
- Surfaces in System Settings → General → Login Items as **"ax studio"** (one
  Developer-ID-attributed item, not anonymous bash).

### Verifying the helper is running

```bash
# Check launchd job is registered and running
launchctl list | grep ax-studio-helper

# Check the ax serve endpoint the helper owns
ax daemon status

# If the helper is running, /api/version will respond
curl -s http://127.0.0.1:1738/api/version | jq .
```

If `ax daemon status` reports a wedged db, run `ax daemon restart` to force a
SIGKILL+respawn of the stuck surreal process.

### Uninstalling / disabling the helper

The helper is registered by the app and tied to the app's code signature. To
remove it:

1. **Via the app:** If an unregister UI is present, use it (calls
   `setLoginItemSettings({ type: 'agentService', serviceName: '...', openAtLogin:
   false })` internally).
2. **Via System Settings:** General → Login Items → find "ax studio" under "Allow
   in the Background" → toggle off or remove.
3. **Via launchctl (manual):**
   ```bash
   launchctl bootout gui/$(id -u)/com.necmttn.ax-studio.helper
   ```
   This stops the job for the current login session. It will re-register on the
   next app launch unless the app also calls `SMAppService.unregister`.
4. **Fully remove:** Delete `ax studio.app` from `/Applications`. macOS
   automatically unregisters all `agentService` jobs whose parent app bundle is
   gone.

### Open smoke item (deferred to maintainer)

The plist's `ProgramArguments` use bundle-root-relative paths (e.g.
`Contents/Resources/ax-src/apps/axctl/src/cli/index.ts`). Launchd's working
directory for SMAppService agents is `/` - those paths are NOT auto-resolved by
launchd the way `BundleProgram` is. **The signed-build smoke (Step 1 of the task-8
brief) must confirm bun actually starts ax serve.** If the agent starts but `ax
serve` fails (check `ax daemon status` + `launchctl list | grep ax-studio-helper`
exit code), switch `BundleProgram` to the shell-wrapper fallback documented in
`docs/superpowers/notes/2026-06-24-agentservice-contract.md §4`, which resolves
paths relative to `$0` before exec.
