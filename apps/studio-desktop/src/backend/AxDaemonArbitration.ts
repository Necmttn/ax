/**
 * Phase 2 / Task 2.1 - `ax studio` attach-vs-spawn arbitration.
 *
 * Wave 3 (`c-desktop-realign`): ax moved off a required SurrealDB daemon onto
 * embedded DuckDB, and `ax serve` (two supervised processes - `surreal` +
 * `ax serve` itself) was retired in favor of `ax studio`, a single ephemeral
 * process that reads a published DuckDB snapshot and exits on its own once
 * idle (see the `c-daemon-studio` chunk, `apps/axctl/src/dashboard/server.ts`).
 * There is exactly one process and one port now, so arbitration collapses to
 * one question: is something already answering healthily on the studio port?
 *
 * - healthy   -> ATTACH. Something (another desktop instance, or a manually
 *   run `ax studio`/`ax serve` from the CLI) already owns the port; do not
 *   spawn a second one. Open the window against it.
 * - unhealthy -> SPAWN. Bring up our own supervised `ax studio` process. If
 *   the port turns out to be genuinely occupied by something unrelated, the
 *   spawned process's own readiness probe times out and the manager bails
 *   loudly (see {@link AxBackendManager} `abortNotReady`) - there is no
 *   separate "conflict" mode to maintain now that a timeout already IS the
 *   failure signal.
 *
 * Residual open question (carried over verbatim): attach mode does not own
 * the attached process's lifecycle - if it dies while desktop is attached,
 * the readiness poller (Task 2.3) detects it and falls back to spawn. The
 * reverse (desktop quits while something else relies on the spawned process)
 * is left for a future "who owns the shared process" arbitration.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

/** Loopback port `ax studio` listens on (matches `DEFAULT_DASHBOARD_PORT`). */
export const AX_STUDIO_PORT = 1738;

const PROBE_TIMEOUT = Duration.seconds(1);

export type ArbitrationMode = "attach" | "spawn";

export interface ArbitrationDecision {
    readonly mode: ArbitrationMode;
}

/** Pure, total decision over the one boolean this arbitration now needs. */
export const decideArbitration = (probe: { readonly studioHealthy: boolean }): ArbitrationDecision =>
    probe.studioHealthy ? { mode: "attach" } : { mode: "spawn" };

/**
 * Probe `ax studio`: `GET http://127.0.0.1:1738/api/version`. Any non-2xx,
 * connection error, or timeout collapses to `false` - total, never fails.
 * Also used by the attach-mode readiness poller to detect the attached
 * process going away.
 */
export const probeStudio: Effect.Effect<boolean, never, HttpClient.HttpClient> = Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    return yield* client.get(`http://127.0.0.1:${AX_STUDIO_PORT}/api/version`).pipe(
        Effect.timeout(PROBE_TIMEOUT),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
    );
});

/** Run the (now single) probe and fold it into a decision. Never fails. */
export const probeArbitration: Effect.Effect<ArbitrationDecision, never, HttpClient.HttpClient> = Effect.gen(
    function* () {
        const studioHealthy = yield* probeStudio;
        return decideArbitration({ studioHealthy });
    },
);
