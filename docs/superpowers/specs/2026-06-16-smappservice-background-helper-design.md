# Studio desktop - background/daemon model (decided: IDE model)

**Date:** 2026-06-16
**Status:** Decided - **Option C (IDE model)**. Background-daemon options (A/B)
rejected.
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
  Delivers true app-closed ingest as a single Developer-ID item. **Rejected for
  v0:** most work, not the IDE norm, and unnecessary once the app auto-launches +
  stays tray-resident. Kept on file as the escape hatch if 24/7 capture is needed.
- **B - bundle the existing agents as SMAppService agents.** 2–3 attributed items
  instead of 5. **Rejected:** still more background items than C, more moving parts.

## Implementation scope (Option C)

- **P1 - Tray + auto-launch.** Menubar/tray presence (open studio, quit) +
  `openAtLogin` toggle (`mainAppService`). Verify the single Login Item renders as
  "ax studio" (Developer ID) on a signed build.
- **P2 - Ingest while open.** Trigger `ax ingest --since=N` (+ derive) on app
  launch and on a `Schedule` while running; reuse the ingest-lock. (Supervisor
  already runs surreal + serve.)
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
    - Sub-steps: **P3a** desktop schema-on-boot (new `DesktopSchema` module +
      wire between surreal-ready and serve-spawn in `AxBackendManager`); **P3b**
      `cmdInstall` skip+migrate when `findDesktopApp()` is truthy (unload+remove
      the 5 plists, keep binary symlinks + runtime-state).
- **P4 - CI release.** macOS runner: build → sign (Developer ID) → notarize
  (`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`) → `--publish
  always` → electron-updater feed.

## Open questions

1. **Quota in-app.** `ax quota` reads the OAuth token from the macOS Keychain via
   `security`. In-app (signed, user session) this should work; confirm the
   hardened-runtime entitlements permit Keychain access, else fall back to
   `~/.claude/.credentials.json`.
2. **TCC / full-disk.** Reading `~/.claude`, `~/.codex` may trip macOS TCC on
   first access; t3code has a permission-loop fix worth lifting before release.

## Not doing (v0)

Headless background daemon (Option A), Windows/Linux services (separate systemd
track), root `daemonService`.
