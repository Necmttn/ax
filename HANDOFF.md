# Handoff: continue `fix/614-bug-studio-desktop-backend-never-spawns` on workbox

Captured for migration to a faster remote box. No new feature work in progress -
this is a clean state snapshot.

## Branch + commit
- **Branch:** `fix/614-bug-studio-desktop-backend-never-spawns`
- **Latest commit:** `e22fa9f6209b57119451a5b870ba66618e61f60c`
  - `fix(studio-desktop): probe ports with node:net, not Bun.listen (#614)`
- **Working tree:** clean, pushed. PR **#615** (OPEN): https://github.com/Necmttn/ax/pull/615

## What this branch does
Fixes the studio-desktop backend never spawning: `AxDaemonArbitration.portFree`
used `Bun.listen`, but the Electron MAIN process runs under Node (no `Bun`), so the
probe always threw → `portsFree` permanently false → arbitration always `conflict`
→ app never started its own surreal+serve. Replaced with `node:net` +
`Effect.callback`. Arbitration suite green, tsc clean. Verified live: the rebuilt
app decides `attach`/`spawn` correctly.

## Session context (what led here)
Started as "compare latitude-llm to ax" → built `ax otel` → found + fixed the
`telemetry_of` correlation bug → then debugged the desktop app crash. Already
**merged to main**: #609 (`ax otel` view), #611 (correlate windowed/incremental +
`CONCURRENTLY` otel index builds). Those are done.

The desktop "crashing / not rendering" turned out to be **4 layered bugs**:
1. `electron-updater` not bundled → crash dialog. Was a **stale installed build**;
   current source already bundles it. → fixed by rebuild.
2. `Bun.listen` in arbitration → **this branch / PR #615**.
3. electron-builder drops `node_modules` from the staged `ax-src` extraResources →
   packaged `ax serve` fails `Cannot find package 'effect'`. → **issue #616 (OPEN)**.
4. After (3), `ax serve` then fails `Cannot find module 'react/jsx-dev-runtime'`
   (cli/index.ts pulls in `progress-tui.tsx`). → **issue #616 (OPEN)**.

#3/#4 only break the app's **self-spawn**; `attach` mode works against a running
daemon, and the studio UI is served directly by `ax serve` at
http://127.0.0.1:1738/ (don't strictly need the desktop app).

## Local machine state (does NOT transfer to the workbox - informational)
- A rebuilt `ax studio.app` was installed to `/Applications` with `node_modules`
  hand-copied into `Resources/ax-src` + ad-hoc re-signed (workaround for #616).
- `surreal` + `ax serve` were running from source (manual, non-persistent).
- The local SurrealDB wedged repeatedly (the trigger for the Docker question below).

## Concrete remaining next steps (in priority order)
1. **Merge PR #615** once CI is green (mergeStateStatus was UNKNOWN at handoff -
   re-check it's CLEAN). Then clean up the `614-fix` worktree + branch.
2. **Fix #616** (packaged `ax serve` can't self-spawn):
   - electron-builder `extraResources: [{ from: "resources/ax-src", to: "ax-src" }]`
     drops `node_modules` (staging builds it correctly at
     `resources/ax-src/node_modules`, 150 pkgs). Needs an explicit include filter
     or a different staging/packaging path (electron-builder 26.8.1).
   - Lazy-load `progress-tui.tsx` so the `ax serve` entry doesn't pull react's dev
     jsx runtime - or stage react with the prod `jsx-runtime`. (`apps/axctl/src/cli/index.ts`.)
3. **DB watchdog - highest-leverage fix for the recurring surreal wedge** (Codex
   review, grounded in `SupervisedProcess.ts` / `AxBackendManager.ts` /
   `AxDaemonArbitration.ts` / `db.ts` / `com.necmttn.ax-db.plist`):
   - Owning supervisor periodically runs `/health` **plus a tiny SQL probe** with
     strict deadlines. On **N consecutive probe timeouts** → classify wedged,
     capture diagnostics, `SIGKILL` the known surreal pid, let LaunchAgent /
     `SupervisedProcess` restart. **Key on probe timeouts, NOT `0% CPU`** (that is
     supporting evidence, not the predicate).
   - Add **per-request query deadlines in `ax serve`** so DB-backed endpoints fail
     fast instead of piling handlers behind a dead websocket (this is what made
     `/api/wrapped` hang).
   - **Ownership/takeover:** record surreal `pid` + `data-dir` + `port` in runtime
     state so orphans (e.g. studio.app crash leaving a SIGTERM-immune listener on
     :8521) are identifiable and force-killable.
4. **Decision settled (no action unless asked):** do NOT make Docker a hard
   dependency for SurrealDB (kills zero-friction install; doesn't fix the
   alive-but-wedged failure class). Optional `AX_DB_BACKEND=docker` for
   server/team/CI only. Do NOT embed surreal in-process (would let a wedged DB
   wedge the app). Fix is **liveness/supervision**, not the engine.

## Quick verification commands on the workbox
```
git checkout fix/614-bug-studio-desktop-backend-never-spawns
bun test ./apps/studio-desktop/src/backend/AxDaemonArbitration.test.ts
gh pr view 615
gh issue view 616
```
