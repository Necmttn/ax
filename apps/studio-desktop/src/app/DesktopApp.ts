import * as Effect from "effect/Effect";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

const { logInfo: logStartupInfo } = DesktopObservability.makeComponentLogger("desktop-startup");

/**
 * Desktop boot program.
 *
 * Phase 1 (this revision): wait for Electron `ready`, install the app menu +
 * (prod) custom protocol, register lifecycle listeners, then open the window
 * against a manually-running daemon. There is no backend supervisor yet, so we
 * call {@link DesktopWindow.handleBackendReady} directly.
 *
 * Phase 2 replaces step 5 with `AxBackendManager.start` driving readiness (the
 * supervisor signals "ready" and that signal calls `handleBackendReady`).
 */
const startup = Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;

    // 1. Block until the Electron app is ready. Scheme privileges were already
    //    registered eagerly in main.ts (must happen before ready).
    yield* electronApp.whenReady.pipe(Effect.withSpan("desktop.electron.whenReady"));
    yield* logStartupInfo("app ready");

    // 2. In production, register the `ax://` custom protocol that serves the
    //    built studio SPA. In development studio is served by Vite, so skip it.
    if (!environment.isDevelopment) {
        yield* electronProtocol.registerDesktopFileProtocol;
    }

    // 3. Install the application menu (macOS App/Edit/View; cleared elsewhere).
    yield* electronMenu.installApplicationMenu;

    // 4. Wire before-quit / activate / window-all-closed / SIGINT / SIGTERM.
    yield* lifecycle.register;

    // 5. Phase 1: open the window against the manually-running daemon.
    //    Phase 2 replaces this with AxBackendManager.start driving readiness.
    yield* desktopWindow.handleBackendReady;
    yield* logStartupInfo("startup complete");
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
    Effect.gen(function* () {
        yield* Effect.annotateLogsScoped({ scope: "desktop" });
        yield* Effect.annotateCurrentSpan({ scope: "desktop" });

        const shutdown = yield* DesktopLifecycle.DesktopShutdown;

        // Mark shutdown complete when the program scope closes, so before-quit
        // handlers awaiting completion unblock even on a Phase-1 (no supervisor)
        // shutdown path.
        yield* Effect.addFinalizer(() => shutdown.markComplete);

        yield* startup;

        // Stay alive until something requests shutdown (before-quit / signal).
        yield* shutdown.awaitRequest;
    }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
