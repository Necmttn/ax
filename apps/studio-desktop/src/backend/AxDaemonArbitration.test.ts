import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
    decideArbitration,
    probeArbitration,
    probeDaemon,
    probeSurreal,
} from "./AxDaemonArbitration.ts";

// ---------------------------------------------------------------------------
// Stub HttpClient: every request resolves with a fixed status (no real I/O).
// ---------------------------------------------------------------------------

const stubHttpLayer = (status: number) =>
    Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
            Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status })),
            ),
        ),
    );

test("both healthy -> attach", () => {
    expect(decideArbitration({ daemonHealthy: true, surrealHealthy: true, portsFree: false }))
        .toEqual({ mode: "attach" });
});
test("ports free -> spawn", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: false, portsFree: true }))
        .toEqual({ mode: "spawn" });
});
test("port occupied but unhealthy -> conflict", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: false, portsFree: false }))
        .toEqual({ mode: "conflict" });
});
test("partial (surreal up, daemon down) but ports occupied -> spawn-ax-only", () => {
    expect(decideArbitration({ daemonHealthy: false, surrealHealthy: true, portsFree: false }))
        .toEqual({ mode: "spawn-ax-only" });
});

// ---------------------------------------------------------------------------
// Launchd-helper invariant: daemonHealthy short-circuits to "attach"
//
// When the background helper owns surreal + ax serve, `daemonHealthy` will be
// true. The app must ATTACH to the existing pair regardless of what
// `surrealHealthy` or `portsFree` say - the daemon's /api/version being healthy
// is the decisive signal that the full backend is up and owned by the helper.
// These tests pin that short-circuit so a refactor can never accidentally add
// branching that ignores the daemon probe.
// ---------------------------------------------------------------------------

test("launchd-helper running: daemonHealthy=true, surrealHealthy=true, portsFree=false → attach (no double-spawn)", () => {
    // The canonical helper-running scenario: both probes healthy, ports occupied.
    // Identical to the "both healthy" case above but explicitly named for the
    // helper invariant so a future refactor knows what it would break.
    expect(decideArbitration({ daemonHealthy: true, surrealHealthy: true, portsFree: false }))
        .toEqual({ mode: "attach" });
});

test("daemonHealthy=true short-circuits to attach even when surrealHealthy=false", () => {
    // ax serve answered /api/version - the backend is up. The surreal /health
    // probe result is irrelevant: if the daemon is healthy, surreal must be too.
    expect(decideArbitration({ daemonHealthy: true, surrealHealthy: false, portsFree: false }))
        .toEqual({ mode: "attach" });
});

test("daemonHealthy=true short-circuits to attach even when portsFree=true", () => {
    // Edge case: daemon probe wins even if the port-bind probe races and sees
    // the ports as free (transient race at startup is theoretically possible).
    expect(decideArbitration({ daemonHealthy: true, surrealHealthy: false, portsFree: true }))
        .toEqual({ mode: "attach" });
});

// ---------------------------------------------------------------------------
// Effect probes: HTTP failures collapse to `false`, success to `true`.
// ---------------------------------------------------------------------------

test("probeDaemon: 503 -> false", async () => {
    const result = await Effect.runPromise(
        probeDaemon.pipe(Effect.provide(stubHttpLayer(503))),
    );
    expect(result).toBe(false);
});

test("probeSurreal: 503 -> false", async () => {
    const result = await Effect.runPromise(
        probeSurreal.pipe(Effect.provide(stubHttpLayer(503))),
    );
    expect(result).toBe(false);
});

test("probeDaemon: 200 -> true", async () => {
    const result = await Effect.runPromise(
        probeDaemon.pipe(Effect.provide(stubHttpLayer(200))),
    );
    expect(result).toBe(true);
});

// ---------------------------------------------------------------------------
// probeArbitration: a healthy daemon (200) short-circuits to attach without
// depending on port-bind state, so this is deterministic with no real ports.
// ---------------------------------------------------------------------------

test("probeArbitration: daemon healthy (200) -> attach", async () => {
    const decision = await Effect.runPromise(
        probeArbitration.pipe(Effect.provide(stubHttpLayer(200))),
    );
    expect(decision).toEqual({ mode: "attach" });
});
