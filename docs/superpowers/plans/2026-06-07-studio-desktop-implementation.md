# Studio Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `ax studio` as a standalone macOS desktop app (Electron + Effect, mirroring `.references/t3code`) that bundles and supervises both `surreal` (:8521) and `ax serve` (:1738, from bundled source for live ingest), and renders the existing studio SPA against the local daemon.

**Architecture:** Three workspaces evolve. (0) The studio SPA is lifted out of the CLI into a first-class `apps/studio/` Vite app with three build targets (`daemon` / `web` / `desktop`). (1) A new `apps/studio-desktop/` Electron-main package (Effect, `@effect/platform-node`) renders the desktop studio build through a privileged custom protocol. (2) A two-process supervisor (adapted from t3code `DesktopBackendManager`) brings up `surreal` then `ax serve`, readiness-polls both, restarts on crash, and shuts down gracefully. (3) electron-builder packages per-arch `surreal` + `bun` binaries with the ax source tree, codesigns + notarizes, and wires electron-updater.

**Tech Stack:** bun ≥ 1.3 workspaces, TypeScript strict (`module: preserve`, `moduleResolution: bundler`), Vite 6 + `@vitejs/plugin-react` + React 19 + TanStack Router/Query (studio), `effect@beta` 4.0.0-beta.70 + `@effect/platform-node` (Electron main), Electron 41, `tsdown` (main/preload CJS bundle), electron-builder + electron-updater, `bun:test`.

---

## Ground truth (read before starting)

These real paths/shapes are referenced throughout. Verify they still exist before relying on them.

- **Approved design doc:** `docs/superpowers/specs/2026-06-07-studio-desktop-design.md` (model-C daemon, 4 phases, locked decisions, open arbitration item).
- **Studio SPA today (no package.json):** `apps/axctl/src/dashboard/web/` - `vite.config.ts`, `index.html`, `tsconfig.json`, `src/` (with `main.tsx`, `api.ts`, `router.tsx`, `mock-fixtures.ts`, `routes/`), `dist/` (gitignored build output).
  - `vite.config.ts` reads `process.env.VITE_STUDIO_MOCK === "true"` → `base: "/studio/"` + `outDir: "dist-studio"`, else `base: "/"` + `outDir: "dist"`. Alias `@shared` → `path.resolve(__dirname, "../../../../../packages/lib/src/shared")` (five `..` from `apps/axctl/src/dashboard/web/`). Dev server on `:1739`, proxies `/api` → `http://127.0.0.1:${AX_DAEMON_PORT ?? 1738}`.
  - `src/api.ts` imports types from `@shared/dashboard-types.ts`; gates mock/live behaviour on `import.meta.env.VITE_STUDIO_MOCK`; `studioConnection` reads/writes `localStorage["ax-studio-endpoint"]`; on load (when mock) parses `?endpoint=` into localStorage and strips it; `jsonFetch` rewrites same-origin `/api/*` → `endpoint + path` in live mode.
- **CLI consumes the SPA via npm scripts** (`apps/axctl/package.json`): `"dashboard:dev": "vite --config src/dashboard/web/vite.config.ts"`, `"dashboard:build": "vite build --config src/dashboard/web/vite.config.ts"`.
- **Daemon is API-only today** (`apps/axctl/src/dashboard/server.ts`): `handleDashboardRequest` answers `/api/*`; non-API GET returns `serveRootLanding()` (a tiny HTML pointer to the hosted studio), **not** the SPA. `/api/version` returns `{ version, api_version: 1, capabilities }`. `POST /api/ingest` returns 503 when the Durable Streams sidecar is absent (the compiled binary case). `serveDashboard(args)` parses `--port=` (default `1738`) and boots `Bun.serve`. CLI flag default also `1738` (`apps/axctl/src/cli/index.ts:4005`).
- **surreal launch command** (`scripts/com.necmttn.ax-db.plist:11`): `exec surreal start --user root --pass root --bind 127.0.0.1:8521 --log info --allow-experimental=files "rocksdb://__DATA_DIR__/db"`.
- **DB connection params** (`packages/lib/src/db.ts`): `url: AX_DB_URL ?? "ws://127.0.0.1:8521"`, `ns: AX_DB_NS ?? "ax"`, `db: AX_DB_DB ?? "main"`.
- **Site deploy** (`apps/site/package.json`): TanStack Start SPA → `vite build` → `dist/client` → `wrangler pages deploy`. `prebuild` currently runs `extract-stage-rationale.ts` + copies `install.sh`. `public/_redirects` has a `/* /index.html 200` SPA fallback. **Note:** the design doc references `scripts/build-studio.ts` and a `public/studio` staging hack from PR #138 - that file is **not present on this branch** (branched from `0.12.0`, pre-#138). Phase 0 establishes the clean mechanism regardless of whether #138 later merges.
- **t3code salvage references** (`.references/t3code/apps/desktop/src/`):
  - `backend/DesktopBackendManager.ts` - `DesktopBackendManager` service (`start`/`stop`/`currentConfig`/`snapshot`); `runBackendProcess` spawns via `ChildProcessSpawner` + `ChildProcess.make(executablePath, [entryPath, ...], {cwd, env, killSignal: "SIGTERM", forceKillAfter})`; `waitForHttpReady(baseUrl, timeout)` GETs a readiness path with `Schedule.spaced` retry; `scheduleRestart` does exponential backoff (`INITIAL_RESTART_DELAY=500ms` → `MAX_RESTART_DELAY=10s`); lifecycle via `Scope`/`Fiber`/`Ref`/`Semaphore`. **Imports only `effect/*` + `effect/unstable/{http,process}` - zero electron.**
  - `electron/ElectronWindow.ts` - `ElectronWindow` service: `create(opts)`, `main`, `reveal`, `setMain`, `destroyAll`, etc.
  - `electron/ElectronProtocol.ts` - `DESKTOP_SCHEME = "t3"`; `layerSchemePrivileges` (registers privileged scheme: standard/secure/supportFetchAPI/corsEnabled); `registerDesktopFileProtocol` resolves a static dir + serves files with SPA index fallback + path-traversal guard (`normalizeDesktopProtocolPathname`).
  - `app/DesktopLifecycle.ts` - `DesktopShutdown` (Deferred-based request/await/complete) + `DesktopLifecycle` (`register` wires `before-quit`/`activate`/`window-all-closed`/SIGINT/SIGTERM; `relaunch`).
  - `app/DesktopObservability.ts` - `makeComponentLogger(component)` → `{logInfo,logWarning,logError}`; `DesktopBackendOutputLog` service (rotating backend stdout/stderr log) + `DesktopBackendOutputLogNoop`.
  - `main.ts` - composes layers and runs `DesktopApp.program` via `NodeRuntime.runMain`; `preload.ts` - `contextBridge.exposeInMainWorld("desktopBridge", …)` (ax needs a near-empty bridge since studio↔daemon is HTTP).
  - `package.json` - `"main": "dist-electron/main.cjs"`, deps `@effect/platform-node`, `effect`, `electron: 41.x`, `electron-updater`; devDep `electron-builder`. **Build uses `vite-plus` (`vp pack`)** - ax has no `vite-plus`, so this plan uses `tsdown` instead (Decision D2).

---

## File structure (locked decomposition)

**Phase 0 - `apps/studio/` (moved from `apps/axctl/src/dashboard/web/`):**
- `apps/studio/package.json` - new, name `@ax/studio`, build scripts per target.
- `apps/studio/vite.config.ts` - rewritten: 3 targets via `STUDIO_TARGET` env; `@shared` alias fixed to `../../packages/lib/src/shared`.
- `apps/studio/tsconfig.json` - extends `../../tsconfig.base.json`.
- `apps/studio/index.html`, `apps/studio/src/**` - moved verbatim.
- `apps/axctl/package.json` - `dashboard:dev`/`dashboard:build` re-pointed (or removed) to delegate to `@ax/studio`.
- `apps/site/package.json` - `@ax/studio` workspace dep + prebuild stages `/studio`.

**Phase 1 - `apps/studio-desktop/`:**
- `package.json`, `tsdown.config.ts`, `tsconfig.json`.
- `src/main.ts` - layer composition + `NodeRuntime.runMain`.
- `src/preload.ts` - minimal `contextBridge` (app metadata only).
- `src/app/DesktopEnvironment.ts`, `src/app/DesktopObservability.ts`, `src/app/DesktopLifecycle.ts`, `src/app/DesktopState.ts`, `src/app/DesktopApp.ts` - lifted/trimmed from t3code.
- `src/electron/ElectronApp.ts`, `src/electron/ElectronWindow.ts`, `src/electron/ElectronProtocol.ts`, `src/electron/ElectronMenu.ts`, `src/electron/ElectronShell.ts` - lifted from t3code.
- `src/window/DesktopWindow.ts` - ax-specific window orchestration.

**Phase 2 - supervisor (in `apps/studio-desktop/src/backend/`):**
- `SupervisedProcess.ts` - generic single-process spawn+readiness+restart (extracted from t3code `runBackendProcess`/`scheduleRestart`).
- `AxBackendManager.ts` - orders surreal → ax serve.
- `AxDaemonArbitration.ts` - attach-vs-spawn + data-dir resolution.
- `*.test.ts` for the three above (bun:test).

**Phase 3 - packaging:**
- `apps/studio-desktop/electron-builder.config.cjs`, `build/entitlements.mac.plist`, `scripts/fetch-binaries.ts`, `scripts/stage-ax-source.ts`.

---

## Decisions made in this plan

- **D1 - Studio build targets:** `apps/studio/vite.config.ts` keys off `STUDIO_TARGET ∈ {daemon, web, desktop}` (replaces the single `VITE_STUDIO_MOCK` boolean). `daemon` = base `/`, outDir `dist`, mock off. `web` = base `/studio/`, outDir `dist-studio`, mock on. `desktop` = base `./` (relative, so assets resolve under the custom-protocol root), outDir `dist-desktop`, mock on. `VITE_STUDIO_MOCK` is still set internally for `web`/`desktop` so existing `import.meta.env.VITE_STUDIO_MOCK` checks in `src/api.ts` keep working unchanged.
- **D2 - Main-process bundler:** `tsdown` (rolldown-based, bun-friendly) replaces t3code's `vite-plus`/`vp pack` for emitting `dist-electron/{main,preload}.cjs`. Externalize `electron` + `electron-updater`; bundle `effect` + `@effect/platform-node`.
- **D3 - Live ingest:** desktop spawns `bun <ax-source>/apps/axctl/src/cli/index.ts serve --port=1738`, never the `--compile` binary (sidecar/native-lmdb constraint).
- **D4 - Daemon arbitration default:** attach to an already-healthy CLI daemon (reuse `:1738` + `:8521`) when both health probes pass; otherwise spawn a supervised pair pointed at the **shared** ax data dir (so desktop and CLI see the same graph). Private-data-dir mode is rejected for v0 (would show an empty graph). Residual open question recorded in Phase 2 Task 1.

---

# Phase 0 - Extract studio into `apps/studio/`

Independently shippable; benefits the web product even without desktop. No studio app-code logic changes - only the move, the vite config, and consumer rewiring.

### Task 0.1: Create the `apps/studio` package skeleton

**Files:**
- Create: `apps/studio/package.json`
- Create: `apps/studio/tsconfig.json`

- [ ] **Step 1: Write `apps/studio/package.json`**

```json
{
  "name": "@ax/studio",
  "version": "0.12.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "description": "ax studio - dashboard SPA for the ax agent-experience graph. Consumed by the daemon, the hosted web deploy, and the desktop app.",
  "type": "module",
  "scripts": {
    "dev": "STUDIO_TARGET=daemon vite",
    "dev:web": "STUDIO_TARGET=web vite",
    "build": "STUDIO_TARGET=daemon vite build",
    "build:web": "STUDIO_TARGET=web vite build",
    "build:desktop": "STUDIO_TARGET=desktop vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ax/lib": "workspace:*",
    "@tanstack/react-query": "^5",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@tanstack/react-router": "^1.169",
    "@tanstack/router-plugin": "^1.167",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6",
    "typescript": "catalog:",
    "vite": "catalog:"
  }
}
```

- [ ] **Step 2: Write `apps/studio/tsconfig.json`** (mirror the existing `apps/axctl/src/dashboard/web/tsconfig.json` but extend the repo base)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "paths": {
      "@shared/*": ["../../packages/lib/src/shared/*"]
    }
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: Verify the package resolves in the workspace**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design && bun install`
Expected: install succeeds, `@ax/studio` appears in the workspace (no version errors). It is empty of source yet - that is fine.

- [ ] **Step 4: Commit**

```bash
git add apps/studio/package.json apps/studio/tsconfig.json bun.lock
git commit -m "feat(studio): scaffold @ax/studio workspace package"
```

### Task 0.2: Move the SPA source into `apps/studio`

**Files:**
- Move: `apps/axctl/src/dashboard/web/{index.html,src/}` → `apps/studio/{index.html,src/}`
- Delete: `apps/axctl/src/dashboard/web/{tsconfig.json,dist/,dist-studio/}` (replaced by the new package; `dist*` are build artifacts)

- [ ] **Step 1: Move source with git (preserves history)**

```bash
cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design
git mv apps/axctl/src/dashboard/web/index.html apps/studio/index.html
git mv apps/axctl/src/dashboard/web/src apps/studio/src
git rm apps/axctl/src/dashboard/web/tsconfig.json
git rm apps/axctl/src/dashboard/web/vite.config.ts
```

- [ ] **Step 2: Remove stale build outputs (untracked)**

```bash
rm -rf apps/axctl/src/dashboard/web/dist apps/axctl/src/dashboard/web/dist-studio
rmdir apps/axctl/src/dashboard/web 2>/dev/null || true
```

- [ ] **Step 3: Verify the SPA tests still find their files** (the move keeps relative imports intact since the whole `src/` moved as a unit)

Run: `bun test apps/studio/src/routes/share-inspect.test.ts`
Expected: PASS (or the same result it gave before the move - run it pre-move first to capture the baseline).

- [ ] **Step 4: Commit**

```bash
git add -A apps/studio apps/axctl/src/dashboard/web
git commit -m "refactor(studio): move dashboard SPA into apps/studio"
```

### Task 0.3: Write the 3-target vite config

**Files:**
- Create: `apps/studio/vite.config.ts`

- [ ] **Step 1: Write `apps/studio/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Studio SPA build. Three targets via STUDIO_TARGET:
 *   - daemon  (default): base "/",        outDir "dist",         mock off
 *                         (legacy daemon-mounted build; also the dev default)
 *   - web:               base "/studio/", outDir "dist-studio",  mock on
 *                         (hosted at ax.necmttn.com/studio/, CORS-fetches a
 *                          user's local daemon; consumed by apps/site)
 *   - desktop:           base "./",       outDir "dist-desktop", mock on
 *                         (served from the Electron custom-protocol root;
 *                          relative base so assets resolve under app://studio/)
 *
 * `web` and `desktop` set VITE_STUDIO_MOCK=true so src/api.ts keeps its
 * existing `import.meta.env.VITE_STUDIO_MOCK` mock/live-connect behaviour.
 */
type StudioTarget = "daemon" | "web" | "desktop";
const TARGET = (process.env.STUDIO_TARGET ?? "daemon") as StudioTarget;

const CONFIG: Record<StudioTarget, { base: string; outDir: string; mock: boolean }> = {
    daemon: { base: "/", outDir: "dist", mock: false },
    web: { base: "/studio/", outDir: "dist-studio", mock: true },
    desktop: { base: "./", outDir: "dist-desktop", mock: true },
};

const { base, outDir, mock } = CONFIG[TARGET];

export default defineConfig({
    root: __dirname,
    base,
    define: {
        "import.meta.env.VITE_STUDIO_MOCK": JSON.stringify(mock ? "true" : "false"),
    },
    plugins: [react()],
    resolve: {
        alias: {
            "@shared": path.resolve(__dirname, "../../packages/lib/src/shared"),
        },
    },
    server: {
        port: 1739,
        strictPort: true,
        proxy: {
            "/api": {
                target: `http://127.0.0.1:${process.env.AX_DAEMON_PORT ?? "1738"}`,
                changeOrigin: false,
                ws: false,
            },
        },
    },
    build: {
        outDir,
        emptyOutDir: true,
        sourcemap: true,
        target: "es2022",
    },
});
```

- [ ] **Step 2: Verify the alias resolves**

Run: `ls /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/packages/lib/src/shared/dashboard-types.ts`
Expected: file exists (the `@shared/dashboard-types.ts` import target).

- [ ] **Step 3: Commit**

```bash
git add apps/studio/vite.config.ts
git commit -m "feat(studio): 3-target vite config (daemon/web/desktop)"
```

### Task 0.4: Verify all three studio builds succeed

**Files:** none (verification only).

- [ ] **Step 1: Build the daemon target**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio && bun run build`
Expected: exits 0; `apps/studio/dist/index.html` exists; asset URLs in it start with `/assets/`.

- [ ] **Step 2: Build the web target**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio && bun run build:web`
Expected: exits 0; `apps/studio/dist-studio/index.html` exists; asset URLs start with `/studio/assets/`.

- [ ] **Step 3: Build the desktop target**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio && bun run build:desktop`
Expected: exits 0; `apps/studio/dist-desktop/index.html` exists; asset URLs are **relative** (start with `./assets/` or `assets/`).

- [ ] **Step 4: Add `dist*` to gitignore if not already covered**

Run: `git -C /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design check-ignore apps/studio/dist/index.html`
Expected: prints the path (ignored). If not, add `apps/studio/dist`, `apps/studio/dist-studio`, `apps/studio/dist-desktop` to the repo `.gitignore`, then commit.

### Task 0.5: Re-point the CLI's dashboard scripts

The CLI no longer owns the SPA. Its `dashboard:*` scripts must delegate to `@ax/studio` so any existing muscle-memory / CI still works.

**Files:**
- Modify: `apps/axctl/package.json`

- [ ] **Step 1: Replace the two `dashboard:*` scripts**

In `apps/axctl/package.json` `scripts`, change:

```json
    "dashboard:dev": "vite --config src/dashboard/web/vite.config.ts",
    "dashboard:build": "vite build --config src/dashboard/web/vite.config.ts"
```

to:

```json
    "dashboard:dev": "bun --filter @ax/studio dev",
    "dashboard:build": "bun --filter @ax/studio build"
```

- [ ] **Step 2: Remove the now-unused vite devDeps from axctl if nothing else uses them**

Run: `rg -n "vite|@vitejs/plugin-react|@tanstack/router-plugin" apps/axctl/src apps/axctl/*.ts`
Expected: if there are **no** other references, remove `vite`, `@vitejs/plugin-react`, `@tanstack/react-router`, `@tanstack/router-plugin`, `@types/react`, `@types/react-dom` from `apps/axctl/package.json` devDeps. If there ARE references (e.g. the OpenTUI react dep needs `@types/react`), leave those. Re-run `bun install`.

- [ ] **Step 3: Verify CLI typecheck + test still pass**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design && bun --filter axctl typecheck && bun --filter axctl test`
Expected: both pass. (The daemon `server.ts` does not import the SPA, so removing `web/` does not break it - confirm no `dashboard/web` import remains: `rg -n "dashboard/web" apps/axctl/src` returns nothing.)

- [ ] **Step 4: Commit**

```bash
git add apps/axctl/package.json bun.lock
git commit -m "refactor(axctl): delegate dashboard scripts to @ax/studio"
```

### Task 0.6: Rewire `apps/site` to consume `@ax/studio` (supersede the copy hack)

The hosted web deploy must stage the studio `web` build into `apps/site/public/studio` so Cloudflare serves `/studio/`.

**Files:**
- Modify: `apps/site/package.json` (add dep + prebuild stage)
- Create: `scripts/stage-studio.ts` (build studio web target + copy into `apps/site/public/studio`)
- Modify: `.gitignore` (ignore `apps/site/public/studio`)

- [ ] **Step 1: Write `scripts/stage-studio.ts`**

```ts
#!/usr/bin/env bun
/**
 * Build the studio `web` target and stage it into apps/site/public/studio so
 * Cloudflare Pages serves it at /studio/. Supersedes the old build-studio.ts
 * copy hack (PR #138): the studio is now a first-class @ax/studio package and
 * this script just builds + copies its dist-studio output.
 */
import { $ } from "bun";
import { cp, rm, access } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const studioDir = path.join(repoRoot, "apps/studio");
const builtDir = path.join(studioDir, "dist-studio");
const target = path.join(repoRoot, "apps/site/public/studio");

await $`bun --filter @ax/studio build:web`.cwd(repoRoot);
await access(path.join(builtDir, "index.html")); // throws if the build is missing
await rm(target, { recursive: true, force: true });
await cp(builtDir, target, { recursive: true });
console.log(`[stage-studio] staged ${builtDir} -> ${target}`);
```

- [ ] **Step 2: Add `@ax/studio` dep + prebuild stage to `apps/site/package.json`**

Add `"@ax/studio": "workspace:*"` to `dependencies`, and prepend the staging call to `prebuild` and `build`:

```json
    "prebuild": "bun ../../scripts/stage-studio.ts && bun ../../scripts/extract-stage-rationale.ts && cp ../../install.sh public/install",
    "build": "bun ../../scripts/stage-studio.ts && bun ../../scripts/extract-stage-rationale.ts && cp ../../install.sh public/install && vite build",
```

- [ ] **Step 3: Ignore the staged output**

Add `apps/site/public/studio` to the repo `.gitignore` (it is a build artifact, not source).

- [ ] **Step 4: Verify staging works end-to-end**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design && bun run scripts/stage-studio.ts`
Expected: prints the staged path; `apps/site/public/studio/index.html` exists and references `/studio/assets/...`.

- [ ] **Step 5: Confirm the SPA fallback does not shadow `/studio/`**

Run: `rg -n "studio" apps/site/public/_redirects`
Expected: no studio-specific rule needed - `public/studio/index.html` is a real file and Cloudflare serves real files before the `/* /index.html 200` catch-all. (If a future change reorders this, add `/studio/* /studio/index.html 200` before the catch-all.)

- [ ] **Step 6: Commit**

```bash
git add scripts/stage-studio.ts apps/site/package.json .gitignore bun.lock
git commit -m "feat(site): stage @ax/studio web build into public/studio"
```

### Task 0.7: Phase 0 gate - repo-wide typecheck + test

**Files:** none.

- [ ] **Step 1: Run the CI gates**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design && bun run typecheck && bun test`
Expected: both pass (site typecheck is strict-null and needs a prior build - if the root `typecheck` script delegates to turbo with `^build`, it will build first; otherwise run `bunx turbo run build typecheck` per the repo convention in CLAUDE.md).

- [ ] **Step 2: Confirm the daemon still boots and answers `/api/version`**

Run (manual): start surreal + `bun apps/axctl/src/cli/index.ts serve --port=1738`, then `curl -s http://127.0.0.1:1738/api/version`
Expected: JSON with `version`, `api_version: 1`, `capabilities`. (The daemon is API-only; this confirms Phase 0 did not regress it.)

---

# Phase 1 - Electron shell (`apps/studio-desktop`)

Mirror the t3code skeleton; render the `desktop` studio build through a custom protocol pointed at `http://127.0.0.1:1738`. **No supervisor yet** - Phase 1 runs against a manually-started `ax serve`.

### Task 1.1: Scaffold `apps/studio-desktop` package + tsdown build

**Files:**
- Create: `apps/studio-desktop/package.json`
- Create: `apps/studio-desktop/tsdown.config.ts`
- Create: `apps/studio-desktop/tsconfig.json`

- [ ] **Step 1: Write `apps/studio-desktop/package.json`**

```json
{
  "name": "@ax/studio-desktop",
  "version": "0.12.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "description": "ax studio desktop app - Electron shell that supervises surreal + ax serve and renders the studio SPA.",
  "type": "module",
  "main": "dist-electron/main.cjs",
  "scripts": {
    "build:main": "tsdown",
    "build:studio": "bun --filter @ax/studio build:desktop",
    "build": "bun run build:studio && bun run build:main",
    "start": "bun run build && electron .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ax/lib": "workspace:*",
    "@effect/platform-node": "4.0.0-beta.70",
    "effect": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "electron": "41.5.0",
    "electron-builder": "26.8.1",
    "electron-updater": "^6.6.2",
    "tsdown": "^0.9.0",
    "typescript": "catalog:"
  }
}
```

- [ ] **Step 2: Write `apps/studio-desktop/tsdown.config.ts`** (emit CJS main + preload; externalize electron)

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/main.ts", "src/preload.ts"],
    format: "cjs",
    outDir: "dist-electron",
    outExtensions: () => ({ js: ".cjs" }),
    sourcemap: true,
    clean: true,
    // Electron + native updater are provided by the Electron runtime, never bundled.
    external: ["electron", "electron-updater"],
    // Bundle effect + platform-node + @ax/* so the main process is self-contained.
    noExternal: [/^effect/, /^@effect\//, /^@ax\//],
});
```

- [ ] **Step 3: Write `apps/studio-desktop/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src", "tsdown.config.ts"]
}
```

- [ ] **Step 4: Add `electron` + `tsdown` to the root catalog if the repo pins shared versions**

Run: `rg -n "catalog" /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/package.json`
Expected: if `electron`/`tsdown` should be cataloged, add them to `workspaces.catalog`; otherwise the explicit versions above stand. Run `bun install`.

- [ ] **Step 5: Commit**

```bash
git add apps/studio-desktop/package.json apps/studio-desktop/tsdown.config.ts apps/studio-desktop/tsconfig.json bun.lock
git commit -m "feat(studio-desktop): scaffold Electron package + tsdown build"
```

### Task 1.2: Lift the framework-agnostic foundation modules from t3code

These import only `effect/*` - copy, fix import paths, trim t3code-specific bits.

**Files:**
- Create: `apps/studio-desktop/src/app/DesktopObservability.ts`
- Create: `apps/studio-desktop/src/app/DesktopState.ts`
- Create: `apps/studio-desktop/src/app/DesktopEnvironment.ts`

- [ ] **Step 1: Copy + adapt `DesktopObservability.ts`**

Copy `.references/t3code/apps/desktop/src/app/DesktopObservability.ts`. Keep `makeComponentLogger(component)` (returns `{logInfo,logWarning,logError}`) and the `DesktopBackendOutputLog` service + `DesktopBackendOutputLogNoop`. Rename the service tag namespace `@t3tools/desktop/...` → `@ax/studio-desktop/...`. Drop any T3-specific OTEL exporter config; keep a console-backed logger + a rotating file writer rooted at the Electron `userData` logs dir (resolved via `DesktopEnvironment`).

- [ ] **Step 2: Write `DesktopState.ts`** (minimal - backendReady flag + quitting flag)

```ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface DesktopStateShape {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
}

export class DesktopState extends Context.Service<DesktopState, DesktopStateShape>()(
    "@ax/studio-desktop/app/DesktopState",
) {}

export const layer = Layer.effect(
    DesktopState,
    Effect.gen(function* () {
        return DesktopState.of({
            backendReady: yield* Ref.make(false),
            quitting: yield* Ref.make(false),
        });
    }),
);
```

- [ ] **Step 3: Write `DesktopEnvironment.ts`** (paths + dev/prod flag; ax-specific - much smaller than t3code's)

Provide a service exposing: `isDevelopment` (`!app.isPackaged`), `appRoot` (packaged: `process.resourcesPath`; dev: repo root), `userDataDir` (`app.getPath("userData")`), `logsDir`, `path` (the `node:path` module), `platform`, `processArch`, and ax-specific resolved paths: `surrealBinaryPath`, `bunBinaryPath`, `axSourceEntry` (`<appRoot>/ax-src/apps/axctl/src/cli/index.ts` packaged; repo path in dev), `studioStaticDir` (`<appRoot>/studio` packaged = the staged `dist-desktop`; `apps/studio/dist-desktop` in dev), and `axDataDir` (resolved in Phase 2). Construct it in `main.ts` from `electron.app` + `node:os`, the way t3code builds `desktopEnvironmentLayer` via `Layer.unwrap`.

- [ ] **Step 4: Typecheck the foundation modules**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design && bun --filter @ax/studio-desktop typecheck`
Expected: passes (no electron import errors - `DesktopEnvironment` imports `electron` only as a type or receives values via its layer constructor).

- [ ] **Step 5: Commit**

```bash
git add apps/studio-desktop/src/app
git commit -m "feat(studio-desktop): lift observability/state/environment from t3code"
```

### Task 1.3: Lift the Electron integration modules

**Files:**
- Create: `apps/studio-desktop/src/electron/ElectronApp.ts`
- Create: `apps/studio-desktop/src/electron/ElectronWindow.ts`
- Create: `apps/studio-desktop/src/electron/ElectronProtocol.ts`
- Create: `apps/studio-desktop/src/electron/ElectronMenu.ts`
- Create: `apps/studio-desktop/src/electron/ElectronShell.ts`

- [ ] **Step 1: Copy `ElectronWindow.ts` verbatim, renaming the service tag**

Copy `.references/t3code/apps/desktop/src/electron/ElectronWindow.ts`; change the tag string `@t3tools/desktop/electron/ElectronWindow` → `@ax/studio-desktop/electron/ElectronWindow`. No other changes (it is generic BrowserWindow management).

- [ ] **Step 2: Copy + adapt `ElectronProtocol.ts`**

Copy `.references/t3code/apps/desktop/src/electron/ElectronProtocol.ts`. Change `DESKTOP_SCHEME = "t3"` → `"ax"`. In `resolveDesktopStaticDir`, replace the t3code candidate list with the ax studio static dir from `DesktopEnvironment.studioStaticDir`. Keep `layerSchemePrivileges`, `normalizeDesktopProtocolPathname` (traversal guard), and the SPA `index.html` fallback. Keep the `isDevelopment` early-return (dev loads the Vite dev server, prod uses the protocol).

- [ ] **Step 3: Write `ElectronApp.ts`** (thin wrapper over `electron.app`)

Provide a service with: `metadata` (Effect yielding `{appName, appVersion}` from `app.getName()`/`app.getVersion()`), `on(event, listener)` (scoped add/removeListener via `acquireRelease`), `quit`, `exit(code)`, `relaunch(opts)`, `whenReady` (Effect over `app.whenReady()`), `requestSingleInstanceLock`. Model on t3code's `ElectronApp.ts` (`.references/t3code/apps/desktop/src/app/DesktopApp.ts` shows usage). Tag `@ax/studio-desktop/electron/ElectronApp`.

- [ ] **Step 4: Write `ElectronMenu.ts` + `ElectronShell.ts`**

`ElectronMenu`: build a minimal macOS app menu (`Menu.setApplicationMenu`) with About / Quit (Cmd+Q) / Reload / Toggle DevTools / standard Edit menu (copy-paste). `ElectronShell`: wrap `shell.openExternal(url)` so studio's external links open in the system browser. Both are thin Effect services. Wire "open external" through preload only if needed (studio links are plain `<a target=_blank>` - Electron intercepts via `webContents.setWindowOpenHandler`; set that in `DesktopWindow`).

- [ ] **Step 5: Typecheck**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design && bun --filter @ax/studio-desktop typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/studio-desktop/src/electron
git commit -m "feat(studio-desktop): lift Electron window/protocol/app/menu/shell"
```

### Task 1.4: Lift lifecycle + write the ax window orchestrator

**Files:**
- Create: `apps/studio-desktop/src/app/DesktopLifecycle.ts`
- Create: `apps/studio-desktop/src/window/DesktopWindow.ts`

- [ ] **Step 1: Copy + adapt `DesktopLifecycle.ts`**

Copy `.references/t3code/apps/desktop/src/app/DesktopLifecycle.ts`. Keep `DesktopShutdown` (Deferred request/await/complete) and `DesktopLifecycle` (`register`, `relaunch`). Remove the `ElectronTheme` dependency if ax skips theme sync for v0 (drop `electronTheme.onUpdated` + `syncAppearance`); otherwise lift a minimal `ElectronTheme`. Rename tags to `@ax/...`. Keep the `before-quit`/`activate`/`window-all-closed`/SIGINT/SIGTERM wiring exactly - this is the graceful-shutdown backbone Phase 2 plugs the supervisor into.

- [ ] **Step 2: Write `DesktopWindow.ts`**

Provide a `DesktopWindow` service with:
- `handleBackendReady`: create (or reveal) the main BrowserWindow and load the studio.
- `activate`: re-create/reveal on macOS dock click.
- `syncAppearance` (optional no-op if theme dropped).

Window creation (1200×800, `webPreferences: { preload: <dist-electron/preload.cjs>, contextIsolation: true, nodeIntegration: false, sandbox: true }`). Loading:
- **dev** (`environment.isDevelopment`): `win.loadURL("http://127.0.0.1:1739/?endpoint=http://127.0.0.1:1738")` (the studio Vite dev server; mock build serves live mode against the daemon).
- **prod**: `win.loadURL("ax://studio/index.html?endpoint=http%3A%2F%2F127.0.0.1%3A1738")` - the `ax` custom protocol serves `dist-desktop`; `src/api.ts` parses `?endpoint=` into `localStorage["ax-studio-endpoint"]` and rewrites `/api/*` to the daemon.

Set `win.webContents.setWindowOpenHandler` to route external URLs through `ElectronShell.openExternal` and deny in-window navigation. Tag `@ax/studio-desktop/window/DesktopWindow`.

- [ ] **Step 3: Typecheck**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design && bun --filter @ax/studio-desktop typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/studio-desktop/src/app/DesktopLifecycle.ts apps/studio-desktop/src/window
git commit -m "feat(studio-desktop): lifecycle + ax window orchestrator"
```

### Task 1.5: Write `main.ts`, `preload.ts`, and the boot program

**Files:**
- Create: `apps/studio-desktop/src/main.ts`
- Create: `apps/studio-desktop/src/preload.ts`
- Create: `apps/studio-desktop/src/app/DesktopApp.ts`

- [ ] **Step 1: Write `preload.ts`** (minimal - studio↔daemon is HTTP, so the bridge only exposes app metadata)

```ts
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("axDesktop", {
    isDesktop: true,
    platform: process.platform,
});
```

- [ ] **Step 2: Write `DesktopApp.ts`** (the boot Effect program)

`program` (an `Effect`): `yield* ElectronApp.whenReady`; register the custom protocol (`ElectronProtocol.registerDesktopFileProtocol` in prod); set the app menu; `yield* DesktopLifecycle.register`; in Phase 1 (no supervisor yet) directly call `DesktopWindow.handleBackendReady` to open the window against the manually-running daemon. (Phase 2 will replace that direct call with `AxBackendManager.start` driving `handleBackendReady` on readiness.) Mirror the structure of `.references/t3code/apps/desktop/src/app/DesktopApp.ts`.

- [ ] **Step 3: Write `main.ts`** (compose layers + run)

Mirror `.references/t3code/apps/desktop/src/main.ts` but drop ssh/cloud/tailscale layers. Build `desktopEnvironmentLayer` via `Layer.unwrap` from `ElectronApp.metadata` + `node:os`. Merge: `electronLayer` (App/Window/Protocol/Menu/Shell + `layerSchemePrivileges`), `DesktopState.layer`, `DesktopObservability.layer`, `DesktopLifecycle.layerShutdown` + `.layer`, `DesktopWindow.layer`, provide `NodeServices.layer` + `NodeHttpClient.layerUndici`. Run `DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain)`.

- [ ] **Step 4: Build the main bundle**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio-desktop && bun run build:main`
Expected: `dist-electron/main.cjs` + `dist-electron/preload.cjs` emitted; no unresolved-import errors.

- [ ] **Step 5: Commit**

```bash
git add apps/studio-desktop/src/main.ts apps/studio-desktop/src/preload.ts apps/studio-desktop/src/app/DesktopApp.ts
git commit -m "feat(studio-desktop): main process boot + minimal preload"
```

### Task 1.6: Phase 1 gate - launch against a manual `ax serve`

**Files:** none (manual verification).

- [ ] **Step 1: Start the daemon manually** (two terminals)

```bash
# terminal A: surreal (uses the repo's normal data dir)
surreal start --user root --pass root --bind 127.0.0.1:8521 --log info \
  --allow-experimental=files "rocksdb://$HOME/.local/share/ax/db"
# terminal B: ax serve from source
cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design
bun apps/axctl/src/cli/index.ts serve --port=1738
```

(Confirm the real data dir first - see Phase 2 Task 1; substitute the resolved path.)

- [ ] **Step 2: Build the studio desktop bundle + launch Electron**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio-desktop && bun run start`
Expected: an Electron window opens showing the studio UI; the connection banner shows the live daemon version (from `/api/version`); navigating to Sessions/Skills/Recall loads real data from `http://127.0.0.1:1738`.

- [ ] **Step 3: Confirm live mode (not mock fixtures)**

In the running app, open a session detail. Expected: real ingested data, not the deterministic mock fixtures from `apps/studio/src/mock-fixtures.ts`. (Live mode is active because `?endpoint=` was set; if you see mock data, the endpoint param did not reach `localStorage` - check the loadURL query encoding.)

- [ ] **Step 4: Record the result** in the PR description / a comment (screenshot of the window with live data).

---

# Phase 2 - Two-process supervisor (medium detail)

Adapt t3code's `DesktopBackendManager` to bring up `surreal` then `ax serve`, with readiness, crash-restart, and graceful shutdown. Replaces the direct `handleBackendReady` call from Phase 1.

### Task 2.1: DESIGN - daemon arbitration + data-dir resolution (do this first)

**Files:**
- Create: `apps/studio-desktop/src/backend/AxDaemonArbitration.ts`
- Create: `apps/studio-desktop/src/backend/AxDaemonArbitration.test.ts`

**Goal:** decide, at boot, whether to **attach** to an already-running healthy daemon or **spawn** a supervised pair - and resolve the shared data dir. This is the design doc's flagged open item.

- [ ] **Step 1: Resolve the canonical ax data dir**

Run: `rg -n "share/ax|getDataDir|dataDir|XDG_DATA|\.local/share|paths" packages/lib/src/*.ts scripts/install-daemon.sh scripts/com.necmttn.ax-db.plist`
Expected: locate where `__DATA_DIR__` / the rocksdb path is resolved (the LaunchAgent plist + install script). Capture the exact path expression and expose it from `@ax/lib` (add/locate a `paths` export) so both CLI and desktop agree. Record the resolved value in `DesktopEnvironment.axDataDir`.

- [ ] **Step 2: Write the arbitration decision (TDD)** - failing test first

```ts
// AxDaemonArbitration.test.ts
import { expect, test } from "bun:test";
import { decideArbitration } from "./AxDaemonArbitration.ts";

test("both healthy -> attach", () => {
    expect(decideArbitration({ daemonHealthy: true, surrealHealthy: true, portsFree: false }))
        .toEqual({ mode: "attach" });
});
test("ports free -> spawn", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: false, portsFree: true }))
        .toEqual({ mode: "spawn" });
});
test("port occupied but unhealthy -> conflict", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: false, portsFree: false }))
        .toEqual({ mode: "conflict" });
});
test("partial (surreal up, daemon down) but ports occupied -> spawn-ax-only", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: true, portsFree: false }))
        .toEqual({ mode: "spawn-ax-only" });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `bun test apps/studio-desktop/src/backend/AxDaemonArbitration.test.ts`
Expected: FAIL (`decideArbitration` not defined).

- [ ] **Step 4: Implement `decideArbitration` + the probe Effects**

`decideArbitration(probe)` is a pure function over `{daemonHealthy, surrealHealthy, portsFree}` returning `{mode: "attach"|"spawn"|"spawn-ax-only"|"conflict"}`. Also implement the probe Effects: `probeDaemon` (GET `http://127.0.0.1:1738/api/version`, 1s timeout, ok ⇒ healthy), `probeSurreal` (GET `http://127.0.0.1:8521/health`, ok ⇒ healthy), and `portsFree` (attempt `Bun`/net bind on 1738 + 8521). **Decision D4:** `attach` ⇒ skip spawning, point the window at `:1738`; `spawn`/`spawn-ax-only` ⇒ start the missing process(es) against the shared `axDataDir`; `conflict` ⇒ surface a dialog ("another process is using ax's ports but is not responding") and do not start.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `bun test apps/studio-desktop/src/backend/AxDaemonArbitration.test.ts`
Expected: PASS.

- [ ] **Step 6: Record the residual open question** in a comment block at the top of `AxDaemonArbitration.ts`: *attach mode does not own the attached daemon's lifecycle - if the CLI daemon dies while the desktop is attached, the desktop must detect it (the readiness poller in Task 2.3 covers this) and fall back to spawn. The reverse (desktop quits while CLI relies on the spawned pair) is left for a future "who owns the shared daemon" arbitration.* Commit.

```bash
git add apps/studio-desktop/src/backend/AxDaemonArbitration.ts apps/studio-desktop/src/backend/AxDaemonArbitration.test.ts
git commit -m "feat(studio-desktop): daemon attach-vs-spawn arbitration"
```

### Task 2.2: Generic supervised-process module

**Files:**
- Create: `apps/studio-desktop/src/backend/SupervisedProcess.ts`
- Create: `apps/studio-desktop/src/backend/SupervisedProcess.test.ts`

**Goal:** extract t3code's single-process spawn + readiness + restart into a reusable unit (drop the `--bootstrap-fd 3` JSON mechanism ax does not use; pass config via argv/env).

- [ ] **Step 1: Define the config + readiness shapes** (mirror t3code `DesktopBackendStartConfig` minus `bootstrap`/`httpBaseUrl` specifics)

```ts
export interface SupervisedProcessConfig {
    readonly name: string;                 // "surreal" | "ax-serve"
    readonly executablePath: string;       // bun or surreal binary
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly readiness: { readonly url: URL; readonly timeout: Duration.Duration };
}
```

- [ ] **Step 2: Implement spawn + readiness + backoff**

Reuse t3code patterns from `DesktopBackendManager.ts`: `ChildProcessSpawner` + `ChildProcess.make(executablePath, [...args], {cwd, env, extendEnv: true, stdin: "ignore", stdout/stderr: "pipe", killSignal: "SIGTERM", forceKillAfter: 2s})`; `waitForHttpReady(url, timeout)` using `HttpClient.filterStatusOk` + `Schedule.spaced(100ms)` + `Effect.timeout`; exponential backoff restart (`INITIAL=500ms`, `MAX=10s`, `delay = min(INITIAL * 2^attempt, MAX)`); `Scope`/`Fiber`/`Ref`/`Semaphore` lifecycle; stdout/stderr drained into `DesktopBackendOutputLog`. Expose `start`, `stop({timeout})`, `snapshot` (`{ready, activePid, restartAttempt}`), and an `onReady`/`onExit` callback hook.

- [ ] **Step 3: Test readiness + restart logic with a fake spawner (TDD)**

Write `SupervisedProcess.test.ts` using `bun:test`, providing a stub `ChildProcessSpawner` + `HttpClient` layer (per the effect-testing skill - override layers, use `TestClock` for backoff timing). Assert: (a) `start` resolves ready once the HTTP probe returns ok; (b) a process exit with `desiredRunning=true` schedules a restart after the backoff delay; (c) `stop` cancels the restart and closes the scope. Run `bun test apps/studio-desktop/src/backend/SupervisedProcess.test.ts` → FAIL then PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/studio-desktop/src/backend/SupervisedProcess.ts apps/studio-desktop/src/backend/SupervisedProcess.test.ts
git commit -m "feat(studio-desktop): generic supervised-process (spawn+readiness+restart)"
```

### Task 2.3: `AxBackendManager` - order surreal then ax serve

**Files:**
- Create: `apps/studio-desktop/src/backend/AxBackendManager.ts`
- Create: `apps/studio-desktop/src/backend/AxBackendManager.test.ts`

- [ ] **Step 1: Compose two `SupervisedProcess` instances in order**

`AxBackendManager` service with `start`/`stop`/`snapshot`. On `start`: run `AxDaemonArbitration` (Task 2.1). For `spawn`/`spawn-ax-only`:
- **surreal** config: `executablePath = environment.surrealBinaryPath`, `args = ["start","--user","root","--pass","root","--bind","127.0.0.1:8521","--log","info","--allow-experimental=files","rocksdb://"+axDataDir+"/db"]`, readiness `http://127.0.0.1:8521/health` (timeout 60s). Skip if `spawn-ax-only` (surreal already healthy).
- **ax serve** config: `executablePath = environment.bunBinaryPath`, `args = [environment.axSourceEntry, "serve", "--port=1738"]`, `cwd = environment.axSourceRoot`, `env` includes `AX_DB_URL`/`AX_DB_NS`/`AX_DB_DB` defaults (matching `packages/lib/src/db.ts`), readiness `http://127.0.0.1:1738/api/version` (timeout 60s).
- Start surreal first, await ready, then start ax serve, await ready, then set `DesktopState.backendReady` and call `DesktopWindow.handleBackendReady`.
For `attach`: skip both, set `backendReady` immediately, open the window.

- [ ] **Step 2: Wire crash-restart ordering**

If surreal crashes, ax serve will lose its DB - on surreal restart, also bounce ax serve (it reconnects on boot). The readiness poller (a periodic re-probe of `/api/version` while running) detects an attached daemon dying and transitions `attach → spawn`. Keep this conservative: log + restart, never silently swallow.

- [ ] **Step 3: Test the ordering + attach path**

`AxBackendManager.test.ts` with stub `SupervisedProcess` + arbitration: assert surreal readiness gates ax-serve start; assert `attach` mode opens the window without spawning; assert `stop` tears down in reverse order (ax serve before surreal). Run → FAIL then PASS.

- [ ] **Step 4: Replace the Phase 1 direct window call**

In `DesktopApp.ts`, replace the direct `DesktopWindow.handleBackendReady` with `AxBackendManager.start`. Add `AxBackendManager.layer` (+ `SupervisedProcess` deps, `ChildProcessSpawner`, `HttpClient`) to `main.ts`. Register `AxBackendManager.stop` as a `DesktopShutdown` finalizer so quit drains both processes (t3code does `Effect.addFinalizer(() => stop())` in the manager).

- [ ] **Step 5: Commit**

```bash
git add apps/studio-desktop/src/backend/AxBackendManager.ts apps/studio-desktop/src/backend/AxBackendManager.test.ts apps/studio-desktop/src/app/DesktopApp.ts apps/studio-desktop/src/main.ts
git commit -m "feat(studio-desktop): two-process supervisor (surreal -> ax serve)"
```

### Task 2.4: Phase 2 gate - boot both daemons in-app + live ingest

**Files:** none (manual verification).

- [ ] **Step 1: Ensure no daemon is already running** (so the app spawns its own pair)

Run: `lsof -iTCP:8521 -sTCP:LISTEN -nP; lsof -iTCP:1738 -sTCP:LISTEN -nP`
Expected: nothing listening (kill any CLI daemon first to exercise spawn mode).

- [ ] **Step 2: Launch the app** (dev - uses repo `surreal`/`bun` on PATH; packaged binaries come in Phase 3)

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio-desktop && bun run start`
Expected: the app spawns surreal + ax serve; the window opens once both are ready; logs show "surreal ready" then "ax-serve ready".

- [ ] **Step 3: Trigger live ingest from the app**

In the studio UI, open the **Live** tab and run an ingest. Expected: `POST /api/ingest` returns a `runId` (NOT 503), progress events stream in, terminal `run_finished` arrives. This is the locked live-ingest requirement - it works because ax serve runs from source (sidecar/lmdb available), not the compiled binary.

- [ ] **Step 4: Verify graceful shutdown**

Quit the app (Cmd+Q). Run: `lsof -iTCP:8521 -sTCP:LISTEN -nP; lsof -iTCP:1738 -sTCP:LISTEN -nP`
Expected: both ports free - the supervisor SIGTERM'd both children on quit.

- [ ] **Step 5: Verify attach mode**

Start a CLI daemon manually (surreal + `ax serve`), then launch the app. Expected: the app attaches (no second pair spawned - `lsof` still shows one listener per port), window opens against the existing daemon. Quit the app; the CLI daemon stays up.

---

# Phase 3 - Packaging (medium detail)

Bundle per-arch `surreal` + `bun` + the ax source tree; electron-builder; codesign + notarize; electron-updater.

### Task 3.1: Vendor `surreal` + `bun` binaries per arch

**Files:**
- Create: `apps/studio-desktop/scripts/fetch-binaries.ts`
- Create (gitignored): `apps/studio-desktop/resources/bin/<arch>/{surreal,bun}`

- [ ] **Step 1: Write `fetch-binaries.ts`**

Download the pinned `surreal` release for the build arch (darwin-arm64 / darwin-x64) from the SurrealDB GitHub releases, and the pinned `bun` release, into `resources/bin/<arch>/`. `chmod +x`. Pin exact versions (record them in a `BINARY_VERSIONS` const) so builds are reproducible. Verify checksums.

- [ ] **Step 2: Run it for the host arch**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio-desktop && bun run scripts/fetch-binaries.ts`
Expected: `resources/bin/$(uname -m)/surreal --version` and `.../bun --version` both run and print the pinned versions.

- [ ] **Step 3: Resolve binary paths in `DesktopEnvironment`** for packaged mode

Packaged: `surrealBinaryPath = <resourcesPath>/bin/<arch>/surreal`, `bunBinaryPath = <resourcesPath>/bin/<arch>/bun`. Dev: fall back to `surreal`/`bun` on PATH. Commit `fetch-binaries.ts` (binaries themselves gitignored).

```bash
git add apps/studio-desktop/scripts/fetch-binaries.ts apps/studio-desktop/src/app/DesktopEnvironment.ts .gitignore
git commit -m "build(studio-desktop): vendor surreal + bun binaries per arch"
```

### Task 3.2: Stage the ax source tree into the bundle

**Files:**
- Create: `apps/studio-desktop/scripts/stage-ax-source.ts`
- Create (gitignored): `apps/studio-desktop/resources/ax-src/**`

- [ ] **Step 1: Write `stage-ax-source.ts`**

Copy the minimal runnable ax source into `resources/ax-src/`: `apps/axctl/`, `packages/lib/`, `packages/schema/`, `packages/ax-classifier-*/` (only what `ax serve` imports - trace from `apps/axctl/src/cli/index.ts`), plus a pruned `node_modules` containing the native deps `ax serve` needs (`surrealdb`, `lmdb`/`@durable-streams/*`, `node-pty`). Because native modules are per-arch, run `bun install` against the staged tree for the target arch, or copy the host `node_modules` only when building for the host arch. Record this as the heaviest/most fragile step (design doc risk: "bun runtime in the bundle").

- [ ] **Step 2: Verify the staged tree runs under the bundled bun**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio-desktop && bun run scripts/stage-ax-source.ts && ./resources/bin/$(uname -m)/bun resources/ax-src/apps/axctl/src/cli/index.ts --help`
Expected: ax CLI help prints (proves the staged source + bundled bun + native deps resolve). Then start `serve` against a temp data dir and confirm `POST /api/ingest` does NOT 503.

- [ ] **Step 3: Stage the studio desktop bundle too**

Ensure `apps/studio/dist-desktop` is copied to `resources/studio/` (the custom-protocol root referenced by `DesktopEnvironment.studioStaticDir`). Add this copy to `stage-ax-source.ts` or a sibling script invoked by the build.

- [ ] **Step 4: Commit the staging script**

```bash
git add apps/studio-desktop/scripts/stage-ax-source.ts
git commit -m "build(studio-desktop): stage ax source + studio bundle into resources"
```

### Task 3.3: electron-builder config + codesign + notarize

**Files:**
- Create: `apps/studio-desktop/electron-builder.config.cjs`
- Create: `apps/studio-desktop/build/entitlements.mac.plist`

- [ ] **Step 1: Write `electron-builder.config.cjs`**

```js
module.exports = {
  appId: "com.necmttn.ax-studio",
  productName: "ax studio",
  directories: { output: "dist-release", buildResources: "build" },
  files: ["dist-electron/**", "package.json"],
  extraResources: [
    { from: "resources/bin", to: "bin" },
    { from: "resources/ax-src", to: "ax-src" },
    { from: "resources/studio", to: "studio" },
  ],
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }, { target: "zip", arch: ["arm64", "x64"] }],
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true, // requires APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env
  },
  // Sign the vendored binaries too (surreal + bun) or they get SIGKILL'd.
  afterSign: "scripts/notarize-check.cjs",
  publish: [{ provider: "github", owner: "Necmttn", repo: "ax" }],
};
```

- [ ] **Step 2: Write `build/entitlements.mac.plist`**

Include `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation` (needed for the spawned bun + native lmdb), and `com.apple.security.cs.allow-dyld-environment-variables`.

- [ ] **Step 3: Note the SIGKILL failure mode in a comment**

In `electron-builder.config.cjs`, document (per memory `dogfood-compiled-binary-codesign`): *the bundled `surreal` and `bun` binaries MUST be codesigned - an unsigned/ad-hoc-copied Mach-O gets SIGKILL'd by macOS on first spawn. electron-builder signs files under `Contents/Resources` when `hardenedRuntime` + a Developer ID identity are set; for local unsigned dev builds, run `codesign --force --sign - resources/bin/*/{surreal,bun}` before launching.*

- [ ] **Step 4: Add `dist` + `package` scripts** to `apps/studio-desktop/package.json`

```json
    "prepackage": "bun run scripts/fetch-binaries.ts && bun run scripts/stage-ax-source.ts && bun run build",
    "package": "bun run prepackage && electron-builder --config electron-builder.config.cjs",
    "package:dir": "bun run prepackage && electron-builder --dir --config electron-builder.config.cjs"
```

- [ ] **Step 5: Verify an unsigned dir build launches**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio-desktop && bun run package:dir`
Then: `codesign --force --sign - dist-release/mac-*/ax\ studio.app/Contents/Resources/bin/*/{surreal,bun}` and open the `.app`.
Expected: the app launches, spawns the bundled surreal + bun (no SIGKILL after the ad-hoc sign), opens the window with live data + working live ingest.

- [ ] **Step 6: Commit**

```bash
git add apps/studio-desktop/electron-builder.config.cjs apps/studio-desktop/build/entitlements.mac.plist apps/studio-desktop/package.json
git commit -m "build(studio-desktop): electron-builder + codesign/notarize config"
```

### Task 3.4: electron-updater + release artifacts

**Files:**
- Modify: `apps/studio-desktop/src/main.ts` (or a new `src/updates/DesktopUpdates.ts`)

- [ ] **Step 1: Lift a minimal `DesktopUpdates`**

Lift t3code's `updates/DesktopUpdates.ts` + `updateMachine` (or write a thin wrapper over `electron-updater`'s `autoUpdater`): on app ready (prod only), `checkForUpdatesAndNotify`; expose check/download/install. Point the feed at the GitHub releases `publish` provider configured in 3.3 (`latest-mac.yml` + blockmap are emitted by electron-builder on `--publish`).

- [ ] **Step 2: Wire it into the boot program**

In `DesktopApp.program`, after the window opens and only when `!isDevelopment`, start the updater check. Guard against running in dev (no feed).

- [ ] **Step 3: Verify the release artifacts are produced**

Run: `cd /Users/necmttn/Projects/ax/.claude/worktrees/studio-desktop-design/apps/studio-desktop && bun run package`
Expected: `dist-release/` contains `ax studio-<version>-arm64.dmg`, `-x64.dmg`, the `.zip`s, `latest-mac.yml`, and `.blockmap` files (the electron-updater feed). With Apple creds set, the dmg is notarized (`spctl -a -t open --context context:primary-signature dist-release/*.dmg` → "accepted").

- [ ] **Step 4: Commit**

```bash
git add apps/studio-desktop/src
git commit -m "feat(studio-desktop): electron-updater + release artifacts"
```

---

## Self-review checklist (run before declaring complete)

- **Spec coverage:** Phase 0 (extract + 3 build targets + site rewire) ✓; Phase 1 (Electron shell + window + observability/lifecycle lifted) ✓; Phase 2 (two-process supervisor + readiness on 8521+1738 + crash-restart + graceful shutdown + arbitration design task) ✓; Phase 3 (per-arch surreal/bun bundling + electron-builder + codesign/notarize + electron-updater) ✓. Live-ingest-from-source requirement enforced in 2.3/2.4/3.2. Open arbitration item is a first-class design task (2.1).
- **Daemon-static-serve nuance:** the spec/prompt assume the daemon "serves the dashboard"; the real `server.ts` is API-only (`serveRootLanding`). Phase 0 preserves the legacy `daemon` build target (`dist`) and the `/api/version` contract without claiming the daemon mounts the SPA. The desktop uses the `desktop` build via custom protocol - no daemon static serve needed.
- **build-studio.ts:** not present on this branch (pre-#138); Phase 0.6 establishes the clean `scripts/stage-studio.ts` mechanism, which supersedes the hack whether or not #138 later merges.
- **Type consistency:** `STUDIO_TARGET` values (`daemon`/`web`/`desktop`), `DESKTOP_SCHEME = "ax"`, service tags `@ax/studio-desktop/...`, and `SupervisedProcessConfig`/`AxBackendManager` names are used consistently across tasks.
