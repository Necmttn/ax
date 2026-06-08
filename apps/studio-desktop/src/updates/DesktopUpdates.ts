import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// `electron-updater` is CommonJS and is left EXTERNAL by tsdown (see
// tsdown.config.ts `external`), so at runtime this resolves to a plain
// `require("electron-updater")`. tsdown emits CJS with esModuleInterop, so the
// default import binds to `module.exports`.
//
// IMPORTANT: `autoUpdater` is a *lazy getter* on `module.exports` - touching it
// instantiates the platform updater (MacUpdater/NsisUpdater/...), which reads
// Electron's `app`. So it MUST NOT be destructured at module scope (that would
// run before Electron is ready and crash). We keep the namespace and read
// `electronUpdater.autoUpdater` lazily, inside the Effect, after app `ready`.
import electronUpdater, { type AppUpdater } from "electron-updater";

import * as DesktopObservability from "../app/DesktopObservability.ts";

const {
    logInfo: logUpdaterInfo,
    logWarning: logUpdaterWarning,
    logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("updates");

export interface DesktopUpdatesShape {
    /**
     * Trigger an update check against the GitHub feed baked into `app-update.yml`
     * at package time. Downloads automatically (`autoDownload = true`) and
     * installs on app quit (`autoInstallOnAppQuit = true`). A failed check is
     * caught + logged here so it never propagates to the caller / crashes boot.
     */
    readonly checkForUpdates: Effect.Effect<void>;
    /** Manually start a download (no-op unless `autoDownload` is false). */
    readonly downloadUpdate: Effect.Effect<void>;
    /** Quit and install a downloaded update. For future UI wiring. */
    readonly quitAndInstall: Effect.Effect<void>;
}

export class DesktopUpdates extends Context.Service<DesktopUpdates, DesktopUpdatesShape>()(
    "@ax/studio-desktop/updates/DesktopUpdates",
) {}

const make = Effect.gen(function* () {
    // Capture the context so the (callback-based) electron-updater event handlers
    // can run Effects (logging) with the foundation logger in scope.
    const context = yield* Effect.context<never>();
    const runLog = (effect: Effect.Effect<void>): void => {
        void Effect.runPromiseWith(context)(effect);
    };

    // Resolve the lazy `autoUpdater` getter once, the first time we configure it.
    // By the time `checkForUpdates` runs, Electron is `ready`, so instantiating
    // the platform updater is safe.
    let configured = false;
    const resolveAutoUpdater = (): AppUpdater => {
        const autoUpdater = electronUpdater.autoUpdater;
        if (!configured) {
            configured = true;

            // Route electron-updater's internal logging through the foundation
            // component logger.
            autoUpdater.logger = {
                info: (message?: unknown) => runLog(logUpdaterInfo(String(message ?? ""))),
                warn: (message?: unknown) => runLog(logUpdaterWarning(String(message ?? ""))),
                error: (message?: unknown) => runLog(logUpdaterError(String(message ?? ""))),
                debug: (message: string) => runLog(logUpdaterInfo(message)),
            };

            autoUpdater.autoDownload = true;
            autoUpdater.autoInstallOnAppQuit = true;

            autoUpdater.on("checking-for-update", () => {
                runLog(logUpdaterInfo("checking for updates"));
            });
            autoUpdater.on("update-available", (info: { readonly version?: string }) => {
                runLog(logUpdaterInfo("update available", { version: info?.version }));
            });
            autoUpdater.on("update-not-available", () => {
                runLog(logUpdaterInfo("no updates available"));
            });
            autoUpdater.on("download-progress", (progress: { readonly percent?: number }) => {
                runLog(
                    logUpdaterInfo("download progress", {
                        percent:
                            typeof progress?.percent === "number"
                                ? Math.floor(progress.percent)
                                : undefined,
                    }),
                );
            });
            autoUpdater.on("update-downloaded", (info: { readonly version?: string }) => {
                runLog(
                    logUpdaterInfo("update downloaded; will install on quit", {
                        version: info?.version,
                    }),
                );
            });
            autoUpdater.on("error", (error: unknown) => {
                runLog(
                    logUpdaterError("updater error", {
                        message: error instanceof Error ? error.message : String(error),
                    }),
                );
            });
        }
        return autoUpdater;
    };

    const checkForUpdates = Effect.gen(function* () {
        const autoUpdater = resolveAutoUpdater();
        yield* logUpdaterInfo("starting update check");
        yield* Effect.promise(() => autoUpdater.checkForUpdatesAndNotify());
    }).pipe(
        // A failed update check (no feed, network down, etc.) must never crash
        // boot - swallow + log.
        Effect.catchCause((cause: Cause.Cause<never>) =>
            logUpdaterError("update check failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.withSpan("desktop.updates.checkForUpdates"),
    );

    const downloadUpdate = Effect.gen(function* () {
        const autoUpdater = resolveAutoUpdater();
        yield* Effect.promise(() => autoUpdater.downloadUpdate());
    }).pipe(
        Effect.catchCause((cause: Cause.Cause<never>) =>
            logUpdaterError("update download failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.withSpan("desktop.updates.downloadUpdate"),
    );

    const quitAndInstall = Effect.sync(() => {
        const autoUpdater = resolveAutoUpdater();
        autoUpdater.quitAndInstall();
    }).pipe(Effect.withSpan("desktop.updates.quitAndInstall"));

    return DesktopUpdates.of({
        checkForUpdates,
        downloadUpdate,
        quitAndInstall,
    });
});

export const layer = Layer.effect(DesktopUpdates, make);
