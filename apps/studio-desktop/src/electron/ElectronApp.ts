import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export interface ElectronAppMetadata {
  readonly appName: string;
  readonly appVersion: string;
}

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
}

export class ElectronApp extends Context.Service<ElectronApp, ElectronAppShape>()(
  "@ax/studio-desktop/electron/ElectronApp",
) {}

const addScopedAppListener = <Args extends ReadonlyArray<unknown>>(
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Electron.app.on(eventName as any, listener as any);
    }),
    () =>
      Effect.sync(() => {
        Electron.app.removeListener(eventName as any, listener as any);
      }),
  ).pipe(Effect.asVoid);

const make = ElectronApp.of({
  metadata: Effect.sync(() => ({
    appName: Electron.app.getName(),
    appVersion: Electron.app.getVersion(),
  })),
  on: addScopedAppListener,
  quit: Effect.sync(() => {
    Electron.app.quit();
  }),
  exit: (code) =>
    Effect.sync(() => {
      Electron.app.exit(code);
    }),
  relaunch: (options) =>
    Effect.sync(() => {
      Electron.app.relaunch(options);
    }),
  whenReady: Effect.promise(() => Electron.app.whenReady()).pipe(Effect.asVoid),
  requestSingleInstanceLock: Effect.sync(() => Electron.app.requestSingleInstanceLock()),
});

export const layer = Layer.succeed(ElectronApp, make);
