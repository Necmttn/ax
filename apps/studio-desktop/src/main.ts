import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as AxBackendManager from "./backend/AxBackendManager.ts";
import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";

// ---------------------------------------------------------------------------
// Environment input - resolved from electron `app` + node `process`/`os`.
// The foundation modules never import electron at module scope, so main.ts is
// the single place these raw values are read.
// ---------------------------------------------------------------------------

// `__dirname` of the bundled main process == `<app>/dist-electron`.
// In dev the repo root is three levels up: dist-electron -> studio-desktop ->
// apps -> repo root.
const repoRoot = NodePath.resolve(__dirname, "..", "..", "..");

const isDevelopment = !Electron.app.isPackaged;

const makeEnvironmentInput: DesktopEnvironment.MakeDesktopEnvironmentInput = {
    dirname: __dirname,
    repoRoot,
    isDevelopment,
    resourcesPath: process.resourcesPath,
    userDataDir: Electron.app.getPath("userData"),
    platform: process.platform,
    processArch: process.arch,
    // Phase 2 (backend supervisor) resolves the real bundled binary locations.
    // Until then we fall back to PATH lookups, which are unused by the Phase 1
    // window-open flow.
    surrealBinaryPath: "surreal",
    bunBinaryPath: process.execPath,
    // Canonical ax data dir: mirror @ax/lib config + daemon install scripts so
    // desktop and the CLI daemon agree on the rocksdb location.
    homeDir: Electron.app.getPath("home"),
    axDataDirOverride: process.env.AX_DATA_DIR,
};

// ---------------------------------------------------------------------------
// Layer composition.
// ---------------------------------------------------------------------------

// Electron service tags. None of these need FileSystem/Path/HttpClient.
const electronLayer = Layer.mergeAll(
    ElectronApp.layer,
    ElectronMenu.layer,
    ElectronProtocol.layer,
    ElectronShell.layer,
    ElectronWindow.layer,
);

// Platform deps: NodeServices supplies FileSystem + Path (+ stdio/terminal/etc);
// NodeHttpClient supplies the HTTP client used by Phase 2 readiness probes.
const platformLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici);

// DesktopEnvironment needs Path (from NodeServices) to build its paths.
const environmentLayer = DesktopEnvironment.layer(makeEnvironmentInput);

// Foundation services. DesktopObservability + DesktopEnvironment need
// FileSystem/Path; DesktopWindow needs DesktopEnvironment + electron services.
const foundationLayer = Layer.mergeAll(
    DesktopState.layer,
    DesktopObservability.layer,
    DesktopLifecycle.layerShutdown,
    DesktopLifecycle.layer,
    DesktopWindow.layer,
).pipe(Layer.provideMerge(environmentLayer));

// Phase 2 backend supervisor, provide-merged ON TOP of foundation so it can
// consume foundation's DesktopState/DesktopWindow/DesktopBackendOutputLog +
// DesktopEnvironment. The platform deps (ChildProcessSpawner/HttpClient) come
// from the platform layer below. Sibling `mergeAll` layers do NOT feed each
// other, so this must be a `provideMerge`, not another `mergeAll` entry.
const foundationWithBackendLayer = AxBackendManager.liveLayer.pipe(
    Layer.provideMerge(foundationLayer),
);

// Application layer = electron services + foundation (incl. backend supervisor),
// provided platform deps.
const desktopApplicationLayer = foundationWithBackendLayer.pipe(
    Layer.provideMerge(electronLayer),
    Layer.provideMerge(platformLayer),
);

// Scheme privileges MUST be registered before app `ready`. t3code applies this
// as an eager layer that everything else is built on top of, so building the
// runtime layer runs the registration first.
const desktopRuntimeLayer = ElectronProtocol.layerSchemePrivileges.pipe(
    Layer.flatMap(() => desktopApplicationLayer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
