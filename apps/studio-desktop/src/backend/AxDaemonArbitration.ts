/**
 * Phase 2 / Task 2.1 - daemon attach-vs-spawn arbitration.
 *
 * At boot the desktop app must decide whether to ATTACH to an already-running
 * healthy ax daemon pair (`surreal` on :8521 + `ax serve` on :1738) or to
 * SPAWN its own pair. This module owns that decision: a pure decision function
 * ({@link decideArbitration}) over a probe of the world, plus the Effect probes
 * that populate that probe.
 *
 * Residual open question (verbatim intent): attach mode does not own the
 * attached daemon's lifecycle - if the CLI daemon dies while desktop is
 * attached, the readiness poller (Task 2.3) detects it and falls back to spawn.
 * The reverse (desktop quits while CLI relies on the spawned pair) is left for a
 * future "who owns the shared daemon" arbitration.
 */
import * as Net from "node:net";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

/** Loopback ports the ax daemon pair listens on. */
export const AX_SERVE_PORT = 1738;
export const SURREAL_PORT = 8521;

const PROBE_TIMEOUT = Duration.seconds(1);

/** Snapshot of the world the arbitration decision is computed from. */
export interface ArbitrationProbe {
    /** `ax serve` answered `GET /api/version` with a 2xx. */
    readonly daemonHealthy: boolean;
    /** `surreal` answered `GET /health` with a 2xx. */
    readonly surrealHealthy: boolean;
    /** Both daemon ports were bindable (nothing is listening). */
    readonly portsFree: boolean;
}

export type ArbitrationMode = "attach" | "spawn" | "spawn-ax-only" | "conflict";

export interface ArbitrationDecision {
    readonly mode: ArbitrationMode;
}

/**
 * Pure, total decision over the 8 boolean combinations:
 *
 * - daemonHealthy -> the whole pair we care about is up; ATTACH (the daemon
 *   can't be healthy without surreal behind it, so surreal/ports are moot).
 * - surrealHealthy && !daemonHealthy && !portsFree -> surreal is up but ax serve
 *   is down and its port is taken; SPAWN just our own ax serve against the
 *   existing surreal (SPAWN-AX-ONLY).
 * - portsFree -> nothing is listening; SPAWN a fresh pair.
 * - else -> ports occupied by something unhealthy we don't understand;
 *   CONFLICT (surface to the user, don't stomp it).
 */
export const decideArbitration = (probe: ArbitrationProbe): ArbitrationDecision => {
    if (probe.daemonHealthy) return { mode: "attach" };
    if (probe.surrealHealthy && !probe.portsFree) return { mode: "spawn-ax-only" };
    if (probe.portsFree) return { mode: "spawn" };
    return { mode: "conflict" };
};

/**
 * Probe `ax serve`: `GET http://127.0.0.1:1738/api/version`. Any non-2xx,
 * connection error, or timeout collapses to `false` - total, never fails.
 */
export const probeDaemon: Effect.Effect<boolean, never, HttpClient.HttpClient> = Effect.gen(
    function* () {
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
        return yield* client.get(`http://127.0.0.1:${AX_SERVE_PORT}/api/version`).pipe(
            Effect.timeout(PROBE_TIMEOUT),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
        );
    },
);

/**
 * Probe `surreal`: `GET http://127.0.0.1:8521/health`. Same total semantics as
 * {@link probeDaemon}.
 */
export const probeSurreal: Effect.Effect<boolean, never, HttpClient.HttpClient> = Effect.gen(
    function* () {
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
        return yield* client.get(`http://127.0.0.1:${SURREAL_PORT}/health`).pipe(
            Effect.timeout(PROBE_TIMEOUT),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
        );
    },
);

/**
 * Try to bind a single loopback TCP port, then close immediately. `true` if it
 * was bindable (free), `false` if the bind failed (occupied).
 *
 * Uses Node's `net` because this runs in the Electron MAIN process, which is
 * Node, NOT Bun - the earlier `Bun.listen` was `undefined` here, so every probe
 * threw and `portsFree` was permanently `false`, which pinned arbitration to
 * `conflict`/`spawn-ax-only` and the app could never spawn its own backend
 * (#614). Total: any error resolves to `false`, never fails.
 */
const portFree = (port: number): Effect.Effect<boolean> =>
    Effect.callback<boolean>((resume) => {
        const server = Net.createServer();
        server.once("error", () => resume(Effect.succeed(false)));
        server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
            server.close(() => resume(Effect.succeed(true)));
        });
        return Effect.sync(() => {
            server.close();
        });
    });

/**
 * `true` only if BOTH daemon ports are currently bindable. Each port is closed
 * immediately after the bind probe.
 */
export const probePortsFree: Effect.Effect<boolean> = Effect.gen(function* () {
    const serveFree = yield* portFree(AX_SERVE_PORT);
    const surrealFree = yield* portFree(SURREAL_PORT);
    return serveFree && surrealFree;
});

/**
 * Run all three probes and fold them into a decision. Probes run concurrently;
 * each is total, so this Effect never fails.
 */
export const probeArbitration: Effect.Effect<ArbitrationDecision, never, HttpClient.HttpClient> =
    Effect.gen(function* () {
        const [daemonHealthy, surrealHealthy, portsFree] = yield* Effect.all(
            [probeDaemon, probeSurreal, probePortsFree],
            { concurrency: "unbounded" },
        );
        return decideArbitration({ daemonHealthy, surrealHealthy, portsFree });
    });
