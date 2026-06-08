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
