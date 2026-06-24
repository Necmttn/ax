/**
 * Tests for the SurrealDB wedge watchdog.
 *
 * Uses TestClock so that time-dependent Schedule behaviour is deterministic
 * and millisecond-fast rather than waiting for real wall-clock intervals.
 */
import { describe, it, expect } from "bun:test";
import { Duration, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { makeSurrealWatchdog } from "./SurrealWatchdog.ts";

// Helper: run an Effect with a TestClock so time is deterministic.
const runTest = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
    Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

describe("makeSurrealWatchdog", () => {
    it("trips onWedged after failuresToTrip consecutive failures", () =>
        runTest(
            Effect.gen(function* () {
                const trips = yield* Ref.make(0);
                yield* Effect.forkChild(
                    makeSurrealWatchdog({
                        probe: Effect.succeed(false), // always wedged
                        onWedged: Ref.update(trips, (n) => n + 1),
                        interval: Duration.seconds(5),
                        failuresToTrip: 3,
                    }),
                );
                // Advance 15 s → sleep(5s) fires 3 times → counter reaches 3 → 1 trip
                yield* TestClock.adjust(Duration.seconds(15));
                expect(yield* Ref.get(trips)).toBe(1);
            }),
        ));

    it("does NOT trip when failures are fewer than failuresToTrip", () =>
        runTest(
            Effect.gen(function* () {
                const trips = yield* Ref.make(0);
                yield* Effect.forkChild(
                    makeSurrealWatchdog({
                        probe: Effect.succeed(false),
                        onWedged: Ref.update(trips, (n) => n + 1),
                        interval: Duration.seconds(5),
                        failuresToTrip: 3,
                    }),
                );
                // 2 ticks → counter=2, not yet tripped
                yield* TestClock.adjust(Duration.seconds(10));
                expect(yield* Ref.get(trips)).toBe(0);
            }),
        ));

    it("resets counter and re-arms after a trip", () =>
        runTest(
            Effect.gen(function* () {
                const trips = yield* Ref.make(0);
                yield* Effect.forkChild(
                    makeSurrealWatchdog({
                        probe: Effect.succeed(false),
                        onWedged: Ref.update(trips, (n) => n + 1),
                        interval: Duration.seconds(5),
                        failuresToTrip: 3,
                    }),
                );
                // 6 ticks → trips at 3 (reset), trips again at 6 → 2 trips total
                yield* TestClock.adjust(Duration.seconds(30));
                expect(yield* Ref.get(trips)).toBe(2);
            }),
        ));

    it("resets counter to 0 on a successful probe", () =>
        runTest(
            Effect.gen(function* () {
                const trips = yield* Ref.make(0);
                let callCount = 0;
                // 2 failures, then 1 success, then 2 more failures → no trip
                const probe = Effect.sync(() => {
                    callCount++;
                    if (callCount === 3) return true; // success resets counter
                    return false;
                });
                yield* Effect.forkChild(
                    makeSurrealWatchdog({
                        probe,
                        onWedged: Ref.update(trips, (n) => n + 1),
                        interval: Duration.seconds(5),
                        failuresToTrip: 3,
                    }),
                );
                // 4 ticks: fail, fail, success(reset), fail → counter=1, no trip
                yield* TestClock.adjust(Duration.seconds(20));
                expect(yield* Ref.get(trips)).toBe(0);
            }),
        ));

    it("trips exactly once per failuresToTrip failures even with mixed results", () =>
        runTest(
            Effect.gen(function* () {
                const trips = yield* Ref.make(0);
                let callCount = 0;
                // pattern: F F F S F F F → trip at 3, reset, 3 more failures → 2 trips
                const probe = Effect.sync(() => {
                    callCount++;
                    // success only at tick 4
                    return callCount === 4;
                });
                yield* Effect.forkChild(
                    makeSurrealWatchdog({
                        probe,
                        onWedged: Ref.update(trips, (n) => n + 1),
                        interval: Duration.seconds(5),
                        failuresToTrip: 3,
                    }),
                );
                // 7 ticks: F F F(trip) S F F F(trip)
                yield* TestClock.adjust(Duration.seconds(35));
                expect(yield* Ref.get(trips)).toBe(2);
            }),
        ));

    it("probe failure (Effect failure, not false return) is treated as not-ok", () =>
        runTest(
            Effect.gen(function* () {
                const trips = yield* Ref.make(0);
                yield* Effect.forkChild(
                    makeSurrealWatchdog({
                        probe: Effect.fail(new Error("connection refused")),
                        onWedged: Ref.update(trips, (n) => n + 1),
                        interval: Duration.seconds(5),
                        failuresToTrip: 3,
                    }),
                );
                yield* TestClock.adjust(Duration.seconds(15));
                expect(yield* Ref.get(trips)).toBe(1);
            }),
        ));

    it("interruption of the forked fiber stops the watchdog cleanly", () =>
        runTest(
            Effect.gen(function* () {
                const trips = yield* Ref.make(0);
                const fiber = yield* Effect.forkChild(
                    makeSurrealWatchdog({
                        probe: Effect.succeed(false),
                        onWedged: Ref.update(trips, (n) => n + 1),
                        interval: Duration.seconds(5),
                        failuresToTrip: 3,
                    }),
                );
                yield* TestClock.adjust(Duration.seconds(10));
                yield* Fiber.interrupt(fiber);
                // No trip should have occurred (only 2 ticks)
                expect(yield* Ref.get(trips)).toBe(0);
            }),
        ));
});
