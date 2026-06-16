import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as AxBackendManager from "../backend/AxBackendManager.ts";
import * as DesktopIngestScheduler from "../backend/DesktopIngestScheduler.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopObservability from "./DesktopObservability.ts";

const { logInfo: logStartupInfo } = DesktopObservability.makeComponentLogger("desktop-startup");

/**
 * Desktop boot program.
 *
 * Phase 2 (this revision): wait for Electron `ready`, install the app menu +
 * (prod) custom protocol, register lifecycle listeners, then hand control to the
 * {@link AxBackendManager}. The manager runs attach-vs-spawn arbitration and -
 * on readiness - sets `backendReady` + opens the window via
 * `DesktopWindow.handleBackendReady` itself (or, in `attach` mode, immediately).
 */
const startup = Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const backendManager = yield* AxBackendManager.AxBackendManager;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const updates = yield* DesktopUpdates.DesktopUpdates;

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

    // 5. Phase 2: hand control to the backend supervisor. It runs arbitration,
    //    orders surreal -> ax serve (or attaches to an existing pair), and opens
    //    the window once the backend is ready.
    yield* backendManager.start;

    // 5b. Keep the graph fresh while the app is open (IDE daemon model - no
    //     background agent). Fire an immediate ingest catch-up, then one every
    //     few minutes, reusing the running daemon's live-ingest pipeline via
    //     POST /api/ingest. Forked into the program scope so it is interrupted on
    //     shutdown. Self-healing: a failed run (e.g. serve not ready at the first
    //     tick) is logged and retried on the next tick, so it is safe to start
    //     here without gating on backend readiness. See
    //     docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md
    yield* Effect.forkScoped(
        DesktopIngestScheduler.run({ sinceDays: 7, interval: Duration.minutes(2) }),
    );

    // 6. Phase 3: kick off an electron-updater check. The update feed comes from
    //    electron-builder's GitHub `publish` config, baked into `app-update.yml`
    //    at package time - there is no feed in development, so a check would only
    //    error. Skip it in dev, and never block boot on it: fork it (it catches +
    //    logs its own failures, so a failed check can never crash the app).
    if (environment.isDevelopment) {
        yield* logStartupInfo("skipping update check in dev (no update feed)");
    } else {
        yield* Effect.forkDetach(updates.checkForUpdates);
    }

    // 7. IDE daemon-model continuity: register the app to launch at login as ONE
    //    Developer-ID Login Item (mainAppService), so ingest/serve resume without
    //    a separate background agent. Prod only (dev isn't in /Applications, and
    //    SMAppService registration there errors). Fail-soft: never block boot.
    if (!environment.isDevelopment) {
        yield* electronApp.setOpenAtLogin(true).pipe(
            Effect.tap(() => logStartupInfo("registered launch-at-login (mainAppService)")),
            Effect.catchCause((cause) =>
                logStartupInfo("could not register launch-at-login", {
                    cause: String(cause),
                }),
            ),
        );
    }

    yield* logStartupInfo("startup complete");
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
    Effect.gen(function* () {
        yield* Effect.annotateLogsScoped({ scope: "desktop" });
        yield* Effect.annotateCurrentSpan({ scope: "desktop" });

        const shutdown = yield* DesktopLifecycle.DesktopShutdown;
        const backendManager = yield* AxBackendManager.AxBackendManager;

        // Mark shutdown complete when the program scope closes, so before-quit
        // handlers awaiting completion unblock even on a Phase-1 (no supervisor)
        // shutdown path.
        yield* Effect.addFinalizer(() => shutdown.markComplete);

        yield* startup;

        // Stay alive until something requests shutdown (before-quit / signal).
        yield* shutdown.awaitRequest;

        // Explicitly tear down the supervised backend BEFORE the scope-close
        // `markComplete` finalizer unblocks the before-quit handler (the manager's
        // own stop finalizer runs on the outer layer scope, which races app exit
        // and orphans the spawned processes). Bounded by a timeout so a stuck
        // stop can never hang the quit: the spawned `bun ax serve` ignores
        // SIGTERM, so teardown depends on the supervisor's forceKill SIGKILL; if
        // that doesn't land in time we still proceed to quit rather than wedge
        // the app. `stop` is idempotent (the finalizer backstop is harmless).
        // KNOWN ISSUE (found by live spawn dogfooding): if forceKill doesn't
        // escalate, the spawned ax-serve can outlive the app - see the
        // SupervisedProcess SIGKILL-escalation TODO.
        yield* backendManager.stop().pipe(
            Effect.timeout(Duration.seconds(6)),
            Effect.ignore,
        );
    }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
