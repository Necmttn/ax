import { expect, test } from "bun:test";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopIngestScheduler from "./DesktopIngestScheduler.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * An HttpClient that records every request it is asked to execute and replies
 * with the supplied status. Lets a test assert what the ingest scheduler POSTs
 * without a real `ax serve` daemon.
 */
const recordingClient = (status = 200) => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) => {
        requests.push(request);
        return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status })),
        );
    });
    return { client, requests } as const;
};

// ---------------------------------------------------------------------------
// triggerIngest
// ---------------------------------------------------------------------------

test("triggerIngest POSTs to the local serve /api/ingest endpoint", async () => {
    const { client, requests } = recordingClient();

    await Effect.runPromise(
        DesktopIngestScheduler.triggerIngest(7).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
        ),
    );

    expect(requests.length).toBe(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toContain("/api/ingest");
});

// ---------------------------------------------------------------------------
// run - the scheduling loop
// ---------------------------------------------------------------------------

test("run fires an initial ingest immediately, before any interval elapses", async () => {
    const { client, requests } = recordingClient();

    const program = Effect.scoped(
        Effect.gen(function* () {
            yield* Effect.forkScoped(
                DesktopIngestScheduler.run({
                    sinceDays: 7,
                    interval: Duration.minutes(5),
                }),
            );
            // No interval elapses; only the immediate first run should have fired.
            yield* TestClock.adjust(Duration.zero);
            return requests.length;
        }),
    ).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(TestClock.layer()),
    );

    expect(await Effect.runPromise(program)).toBe(1);
});

test("run fires again after each configured interval", async () => {
    const { client, requests } = recordingClient();

    const counts = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                yield* Effect.forkScoped(
                    DesktopIngestScheduler.run({
                        sinceDays: 1,
                        interval: Duration.minutes(5),
                    }),
                );
                yield* TestClock.adjust(Duration.zero);
                const afterInitial = requests.length;
                yield* TestClock.adjust(Duration.minutes(5));
                const afterFirstTick = requests.length;
                yield* TestClock.adjust(Duration.minutes(5));
                const afterSecondTick = requests.length;
                return { afterInitial, afterFirstTick, afterSecondTick };
            }),
        ).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provide(TestClock.layer()),
        ),
    );

    expect(counts).toEqual({
        afterInitial: 1,
        afterFirstTick: 2,
        afterSecondTick: 3,
    });
});

test("a failed ingest run does not stop the loop - it recovers on the next tick", async () => {
    // The serve daemon is briefly unreachable: the first run fails, later runs
    // succeed. The scheduler must keep ticking rather than die on first failure.
    let calls = 0;
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) => {
        requests.push(request);
        calls += 1;
        return calls === 1
            ? Effect.die(new Error("connection refused"))
            : Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
              );
    });

    const counts = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                yield* Effect.forkScoped(
                    DesktopIngestScheduler.run({
                        sinceDays: 1,
                        interval: Duration.minutes(5),
                    }),
                );
                yield* TestClock.adjust(Duration.zero);
                const afterFailed = requests.length;
                yield* TestClock.adjust(Duration.minutes(5));
                const afterRecovery = requests.length;
                return { afterFailed, afterRecovery };
            }),
        ).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provide(TestClock.layer()),
        ),
    );

    expect(counts).toEqual({ afterFailed: 1, afterRecovery: 2 });
});
