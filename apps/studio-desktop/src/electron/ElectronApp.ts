import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export interface ElectronAppMetadata {
  readonly appName: string;
  readonly appVersion: string;
}

/** Status values returned by SMAppService for an agentService (macOS 13+). */
export type AgentServiceStatus = "not-registered" | "enabled" | "requires-approval" | "not-found";

/** Identifier for the background helper LaunchAgent (must match plist Label + filename). */
export const BACKGROUND_HELPER_SERVICE_NAME = "com.necmttn.ax-studio.helper" as const;

export interface ElectronAppShape {
  readonly metadata: Effect.Effect<ElectronAppMetadata>;
  readonly on: <Args extends ReadonlyArray<unknown>>(
    eventName: string,
    listener: (...args: Args) => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly quit: Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<void>;
  readonly relaunch: (options: Electron.RelaunchOptions) => Effect.Effect<void>;
  readonly whenReady: Effect.Effect<void>;
  readonly requestSingleInstanceLock: Effect.Effect<boolean>;
  /**
   * Register/unregister the app to launch at login as ONE macOS Login Item
   * attributed to the app's Developer ID (`mainAppService`, macOS 13+). This is
   * the IDE daemon model's continuity mechanism - the signed app itself is the
   * single Login Item, replacing the 5 loose "bash" LaunchAgents.
   */
  readonly setOpenAtLogin: (enabled: boolean) => Effect.Effect<void>;
  readonly getOpenAtLogin: Effect.Effect<boolean>;
  /**
   * Register the background helper LaunchAgent (`com.necmttn.ax-studio.helper`)
   * with launchd via SMAppService `agentService` (macOS 13+). The plist must be
   * bundled at `Contents/Library/LaunchAgents/com.necmttn.ax-studio.helper.plist`
   * (done by Task 4). No-op on non-darwin platforms.
   *
   * Runs alongside `setOpenAtLogin` (mainAppService) - the helper agent service
   * and the app's own login item are independent: the helper owns the backend
   * (surreal + ax serve), the login item ensures the app itself auto-launches.
   */
  readonly registerBackgroundHelper: Effect.Effect<void>;
  /**
   * Unregister the background helper from launchd. No-op on non-darwin.
   */
  readonly unregisterBackgroundHelper: Effect.Effect<void>;
  /**
   * Query the SMAppService status of the background helper. Returns
   * `"not-registered"` on non-darwin platforms. `"not-found"` means the plist
   * is absent from the bundle (app was not packaged correctly).
   * `"requires-approval"` means the user must allow it in System Settings →
   * General → Login Items (first-time registration on macOS 13+).
   */
  readonly helperStatus: Effect.Effect<AgentServiceStatus>;
}

export class ElectronApp extends Context.Service<ElectronApp, ElectronAppShape>()(
  "@ax/studio-desktop/electron/ElectronApp",
) {}

// ---------------------------------------------------------------------------
// Minimal interface satisfied by both Electron.app and test stubs.
// Only the methods actually used by ElectronApp are listed here.
// ---------------------------------------------------------------------------

export interface ElectronAppLike {
  getName(): string;
  getVersion(): string;
  on(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  quit(): void;
  exit(exitCode?: number): void;
  relaunch(options?: { args?: string[]; execPath?: string }): void;
  whenReady(): Promise<void>;
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
  setLoginItemSettings(settings: {
    openAtLogin?: boolean;
    type?: string;
    serviceName?: string;
    [key: string]: unknown;
  }): void;
  getLoginItemSettings(options?: {
    type?: string;
    serviceName?: string;
    [key: string]: unknown;
  }): { openAtLogin: boolean; status?: string; [key: string]: unknown };
}

// ---------------------------------------------------------------------------
// Factory (accepts a test stub or the real Electron.app)
// ---------------------------------------------------------------------------

const addScopedListener =
  (app: ElectronAppLike) =>
  <Args extends ReadonlyArray<unknown>>(
    eventName: string,
    listener: (...args: Args) => void,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => {
        app.on(eventName, listener as any);
      }),
      () =>
        Effect.sync(() => {
          app.removeListener(eventName, listener as any);
        }),
    ).pipe(Effect.asVoid);

/**
 * Build an `ElectronAppShape` from any object that satisfies `ElectronAppLike`.
 * Used directly in tests (pass a stub); the production `layer` calls this with
 * the real `Electron.app`.
 */
export const makeFrom = (app: ElectronAppLike): ElectronAppShape => {
  const isDarwin = process.platform === "darwin";

  return ElectronApp.of({
    metadata: Effect.sync(() => ({
      appName: app.getName(),
      appVersion: app.getVersion(),
    })),
    on: addScopedListener(app),
    quit: Effect.sync(() => {
      app.quit();
    }),
    exit: (code) =>
      Effect.sync(() => {
        app.exit(code);
      }),
    relaunch: (options) =>
      Effect.sync(() => {
        app.relaunch(options);
      }),
    whenReady: Effect.promise(() => app.whenReady()).pipe(Effect.asVoid),
    requestSingleInstanceLock: Effect.sync(() => app.requestSingleInstanceLock()),
    setOpenAtLogin: (enabled) =>
      Effect.sync(() => {
        app.setLoginItemSettings({ openAtLogin: enabled, type: "mainAppService" });
      }),
    getOpenAtLogin: Effect.sync(
      () => app.getLoginItemSettings({ type: "mainAppService" }).openAtLogin,
    ),
    registerBackgroundHelper: isDarwin
      ? Effect.sync(() => {
          app.setLoginItemSettings({
            type: "agentService",
            serviceName: BACKGROUND_HELPER_SERVICE_NAME,
            openAtLogin: true,
          });
        })
      : Effect.void,
    unregisterBackgroundHelper: isDarwin
      ? Effect.sync(() => {
          app.setLoginItemSettings({
            type: "agentService",
            serviceName: BACKGROUND_HELPER_SERVICE_NAME,
            openAtLogin: false,
          });
        })
      : Effect.void,
    helperStatus: isDarwin
      ? Effect.sync(() => {
          const { status } = app.getLoginItemSettings({
            type: "agentService",
            serviceName: BACKGROUND_HELPER_SERVICE_NAME,
          }) as { status: AgentServiceStatus };
          return status ?? "not-registered";
        })
      : Effect.succeed("not-registered" as AgentServiceStatus),
  });
};

export const layer = Layer.succeed(ElectronApp, makeFrom(Electron.app as unknown as ElectronAppLike));
