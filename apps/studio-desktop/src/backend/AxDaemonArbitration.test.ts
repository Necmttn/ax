import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { decideArbitration, probeArbitration, probeStudio } from "./AxDaemonArbitration.ts";

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

test("studio healthy -> attach", () => {
    expect(decideArbitration({ studioHealthy: true })).toEqual({ mode: "attach" });
});
test("studio unhealthy -> spawn", () => {
    expect(decideArbitration({ studioHealthy: false })).toEqual({ mode: "spawn" });
});

// ---------------------------------------------------------------------------
// Effect probe: HTTP failures collapse to `false`, success to `true`.
// ---------------------------------------------------------------------------

test("probeStudio: 503 -> false", async () => {
    const result = await Effect.runPromise(
        probeStudio.pipe(Effect.provide(stubHttpLayer(503))),
    );
    expect(result).toBe(false);
});

test("probeStudio: 200 -> true", async () => {
    const result = await Effect.runPromise(
        probeStudio.pipe(Effect.provide(stubHttpLayer(200))),
    );
    expect(result).toBe(true);
});

// ---------------------------------------------------------------------------
// probeArbitration: folds the single probe into a decision.
// ---------------------------------------------------------------------------

test("probeArbitration: studio healthy (200) -> attach", async () => {
    const decision = await Effect.runPromise(
        probeArbitration.pipe(Effect.provide(stubHttpLayer(200))),
    );
    expect(decision).toEqual({ mode: "attach" });
});

test("probeArbitration: studio unhealthy (503) -> spawn", async () => {
    const decision = await Effect.runPromise(
        probeArbitration.pipe(Effect.provide(stubHttpLayer(503))),
    );
    expect(decision).toEqual({ mode: "spawn" });
});
