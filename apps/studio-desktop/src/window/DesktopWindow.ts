import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

/**
 * Studio Vite dev server (mock build, served in live mode against the daemon).
 * `?endpoint=` is parsed by studio's `src/api.ts` into
 * `localStorage["ax-studio-endpoint"]` so `/api/*` is proxied to the daemon.
 */
const DEV_STUDIO_URL = "http://127.0.0.1:1739/?endpoint=http://127.0.0.1:1738";

/**
 * Production URL: the `ax` custom protocol (see {@link ElectronProtocol})
 * serves the built studio SPA (`dist-desktop`). The `?endpoint=` query points
 * studio at the locally-running daemon.
 */
const PROD_STUDIO_URL = "ax://studio/index.html?endpoint=http%3A%2F%2F127.0.0.1%3A1738";

const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;

export type DesktopWindowError = ElectronWindow.ElectronWindowCreateError;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | ElectronShell.ElectronShell
  | ElectronWindow.ElectronWindow;

export interface DesktopWindowShape {
  /**
   * Create (or reveal an existing) main BrowserWindow and load the studio.
   * Phase 1: called once a manually-running daemon is reachable. Phase 2 wires
   * this to the backend supervisor's "ready" signal.
   */
  readonly handleBackendReady: Effect.Effect<void, DesktopWindowError>;
  /** macOS dock-click: re-create or reveal the main window. */
  readonly activate: Effect.Effect<void, DesktopWindowError>;
  /** Theme sync dropped for v0 - kept as a no-op so the lifecycle wiring stays generic. */
  readonly syncAppearance: Effect.Effect<void>;
}

export class DesktopWindow extends Context.Service<DesktopWindow, DesktopWindowShape>()(
  "@ax/studio-desktop/window/DesktopWindow",
) {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  DesktopObservability.makeComponentLogger("desktop-window");

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const createWindow = Effect.gen(function* () {
    const applicationUrl = environment.isDevelopment ? DEV_STUDIO_URL : PROD_STUDIO_URL;
    const window = yield* electronWindow.create({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: environment.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Security: route safe external links to the system browser and deny any
    // attempt to open a new in-window navigation target.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });

    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        void runPromise(
          logWindowWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      void runPromise(
        logWindowWarning("main window render process gone", {
          reason: details.reason,
          exitCode: details.exitCode,
        }),
      );
    });

    window.once("ready-to-show", () => {
      void runPromise(electronWindow.reveal(window));
    });

    void window.loadURL(applicationUrl);
    if (environment.isDevelopment) {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return window;
  });

  const createMain = Effect.gen(function* () {
    const window = yield* createWindow;
    yield* electronWindow.setMain(window);
    yield* logWindowInfo("main window created");
    return window;
  }).pipe(Effect.withSpan("desktop.window.createMain"));

  const revealOrCreateMain = Effect.gen(function* () {
    const existingWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(existingWindow)) {
      yield* electronWindow.reveal(existingWindow.value);
      return existingWindow.value;
    }
    return yield* createMain;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  return DesktopWindow.of({
    handleBackendReady: Effect.gen(function* () {
      yield* logWindowInfo("backend ready", { source: "http" });
      yield* revealOrCreateMain;
    }).pipe(Effect.withSpan("desktop.window.handleBackendReady")),
    activate: revealOrCreateMain.pipe(
      Effect.asVoid,
      Effect.withSpan("desktop.window.activate"),
    ),
    syncAppearance: Effect.void,
  });
});

export const layer = Layer.effect(DesktopWindow, make);
