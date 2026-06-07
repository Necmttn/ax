# Studio desktop - design

**Date:** 2026-06-07
**Status:** Approved direction; build deferred (web reachability shipped first via #129/PR #138).
**Decision owner:** Necmttn

## Problem

`ax serve` prints `open in studio https://ax.necmttn.com/studio/?endpoint=http://127.0.0.1:1738`. Studio is the dashboard UI; the daemon (`ax serve`) is API-only. Two goals:

1. **(shipped)** Make studio reachable on the web - see PR #138 (`_redirects` + bundle staged into `apps/site/public/studio`, plus the daemon Private-Network-Access CORS header).
2. **(this doc)** Wrap studio as a **standalone desktop app** so users get a real app, not a hosted page pointed at loopback.

## Why desktop solves more than it costs

The hosted-web flow is structurally awkward: an HTTPS public page reaching a loopback HTTP daemon trips Chrome Private Network Access and looks broken. A desktop app **dissolves that problem** - everything is local, the app owns the daemon lifecycle, and "open studio" becomes "open the app".

Studio is already desktop-ready: it's a pure React+Vite+TanStack SPA that talks to the daemon **only over HTTP at a configurable endpoint** (`localStorage ax-studio-endpoint`, `?endpoint=`). It is daemon-agnostic. Desktop wrapping is additive - no studio app-code changes required.

## Decisions (locked)

| Question | Decision |
|---|---|
| Daemon model | **Standalone** - app bundles + supervises the daemon |
| Live ingest in desktop? | **Required** |
| Shell framework | **Electron + Effect**, mirroring `.references/t3code` (`pingdotgg/t3code`) |
| Platform | **macOS first** (Electron keeps Win/Linux open later) |

### Why Electron over Electrobun

Electrobun (pre-1.0, solo-maintained, ~14MB system-webview apps, 4KB diff updates) is attractive on size/elegance, and bun-as-main makes the daemon model native. But:

- t3code is a **tested, Effect-native Electron desktop in our exact stack** that already solves the hard part (daemon supervision, custom protocol, updater, window lifecycle, macOS TCC). Going Electrobun **discards exactly that hardened integration layer** and keeps only the framework-agnostic Effect logic - which is the easy part to write regardless.
- Electrobun MVP ≈ 2 weeks with unknowns; Electron-mirroring-t3code ≈ ~1 week with a reference to crib.
- Cost accepted: Chromium bundle (~100MB+) and full/block-map updates vs Electrobun's tiny artifacts.

Electrobun stays documented here as the smaller-binary alternative if bundle size ever becomes a priority and the desktop surface has stabilized.

## Architecture

### Daemon model (model C)

The desktop app supervises **two** child processes (t3code supervises one - this is the main ax-specific delta):

1. **`surreal`** - SurrealDB on `127.0.0.1:8521` (bundled binary; per-arch).
2. **`ax serve`** - the HTTP API on `127.0.0.1:1738`, run **from bundled source via bun**, NOT the `--compile` binary.

> **Why from-source bun, not the compiled binary:** the compiled binary cannot host the Durable Streams sidecar (native lmdb can't bundle), so it returns 503 on `POST /api/ingest` - i.e. no live ingest (see CLAUDE.md "Live ingest needs ax from source"). Live ingest is a locked requirement, so the desktop must ship a bun runtime + ax source and spawn `ax serve` the same way `bin/axctl` does.

Supervisor responsibilities: spawn both, **readiness-poll both** (`/api/version` on 1738; SurrealDB health on 8521), restart-on-crash with backoff, structured logs, graceful shutdown on quit. This is a direct adaptation of t3code's `DesktopBackendManager` (which already does readiness polling + `Schedule` retry + `Fiber`/`Scope` lifecycle for one process).

### Window / UI

- BrowserWindow loads the **bundled studio** (the `VITE_STUDIO_MOCK=true` build, base `/studio/` or `/`) via a privileged custom file protocol (t3code's `ElectronProtocol` pattern), with the endpoint pre-set to `http://127.0.0.1:1738`.
- Studio↔daemon is **HTTP**, not Electron IPC - so the shell needs almost no renderer IPC (big simplification vs t3code, which has a large ssh/cloud IPC surface).

### Packaging / distribution

- **electron-builder** (t3code uses it).
- **Codesign + notarize** required on macOS. Note the known failure mode: an unsigned/`cp`'d binary gets SIGKILL on macOS until `codesign --force --sign -` (see memory `dogfood-compiled-binary-codesign`). Bundled `surreal` + any native bits must be signed in the build.
- **electron-updater** for auto-update.

### Prerequisite: extract studio into its own workspace app

Today studio lives at `apps/axctl/src/dashboard/web` with **no package.json** (buried in the CLI). Phase 0 lifts it to `apps/studio/` as a first-class workspace app. Both consumers then share it:

- **Web deploy** consumes the package (supersedes the `scripts/build-studio.ts` copy-into-`public/studio` hack from #138).
- **Desktop** bundles the same built output.

## t3code salvage map

t3code desktop ≈ 10.5k LOC. Electron quarantined behind one `electron/` layer; almost everything else is `el:0` pure Effect.

| Bucket | Approx LOC | Modules | Action |
|---|---|---|---|
| **Lift ~clean** (framework-agnostic Effect) | ~3.5–4k | `backend/DesktopBackendManager` (606, imports only `effect/unstable/{http,process}` - **zero electron**), `app/DesktopObservability` (OTEL), `app/DesktopLifecycle`, `app/DesktopEnvironment`, `settings/*`, `updates/updateMachine`+`DesktopUpdates`, `app/DesktopConfig`/`State`/`Identity`/`Assets` | copy, fix imports, trim |
| **Electron integration** | ~2k | `electron/*` (App, Window, Protocol, Menu, Dialog, Theme, SafeStorage, Shell, Updater), `main.ts`, `window/DesktopWindow` | reuse directly on the Electron path |
| **Drop** (remote-dev features ax has no use for) | ~2.5–3k | `ssh/*`, `backend/DesktopServerExposure` + `tailscaleEndpointProvider` (relay/tailscale), `app/DesktopCloudAuth*`, `settings/DesktopSavedEnvironments`, the ssh/cloud IPC methods | omit |

**Effort (mac-first MVP, Electron):** ~1 week. t3code provides ~1.5–2 weeks of head start (the whole hardened shell drops in). Remaining net-new ax work: two-process supervisor (surreal + bun `ax serve`), surreal binary bundling + signing, studio extraction (Phase 0).

## Phased rollout

- **Phase 0 - Extract studio** → `apps/studio/` workspace app; rewire web deploy to consume it. (Also benefits the web product independent of desktop.)
- **Phase 1 - Electron shell** (mirror t3code skeleton): window + bundled studio + boot, menu/tray/quit, observability/lifecycle lifted from t3code.
- **Phase 2 - Two-process supervisor**: adapt `DesktopBackendManager` for `surreal` + bun `ax serve`, readiness on 8521+1738, crash-restart, graceful shutdown. (Verifies live ingest works in-app.)
- **Phase 3 - Packaging**: surreal binary bundling (per-arch), electron-builder, codesign + notarize, electron-updater + release artifacts.

## Risks / open items

- **surreal binary**: bundle per-arch, locate/launch with the app's data dir, sign it (SIGKILL otherwise).
- **bun runtime in the bundle**: shipping ax-from-source + bun for live ingest increases bundle weight and adds a "find/launch bun" step - confirm bun can be embedded or vendored cleanly.
- **Data dir / single-instance**: desktop daemon vs an already-installed CLI daemon both wanting `:8521`/`:1738` and the same SurrealDB data dir - need port/instance arbitration (reuse an existing healthy daemon? or own a private data dir?). **Open.**
- **t3code drift**: reference is a stale-prone clone (see memory `references-keep-updated`); re-pull before lifting code.
- **macOS TCC**: t3code has a permission-loop fix (`b76f161`) worth reading before release.

## Not doing (YAGNI for v0)

Remote/SSH environments, Tailscale/relay exposure, cloud auth, Windows/Linux builds, secure keychain storage (no creds in studio yet).
