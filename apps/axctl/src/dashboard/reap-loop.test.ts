import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { DbError } from "@ax/lib/errors";
import { reapIntervalSeconds, runReapSchedule, superviseReapLoop } from "./reap-loop.ts";

describe("reapIntervalSeconds", () => {
    test("defaults to 300s", () => {
        expect(reapIntervalSeconds({} as NodeJS.ProcessEnv)).toBe(300);
    });

    test("honours AX_REAP_INTERVAL_SECONDS", () => {
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "30" } as NodeJS.ProcessEnv)).toBe(30);
    });

    test("0 disables the loop; garbage falls back to the default", () => {
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "0" } as NodeJS.ProcessEnv)).toBe(0);
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "nonsense" } as NodeJS.ProcessEnv)).toBe(300);
    });

    // An exported-but-blank env var (launchd plist entry, shell profile line)
    // must read as UNSET, not as an explicit "0" disable - `Number("")` and
    // `Number(" ")` are both `0`, which is finite and `>= 0`.
    test("empty or whitespace-only value falls back to the default (unset, not disabled)", () => {
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "" } as NodeJS.ProcessEnv)).toBe(300);
        expect(reapIntervalSeconds({ AX_REAP_INTERVAL_SECONDS: "   " } as NodeJS.ProcessEnv)).toBe(300);
    });
});

describe("superviseReapLoop", () => {
    // Flush the microtask queue so a synchronously-rejected `run()`'s
    // `.catch` handler (and any onError/scheduleRetry it triggers) has run.
    const flush = async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
    };

    test("a rejected run is re-armed after intervalMs, not dropped", async () => {
        let calls = 0;
        const scheduled: Array<{ fn: () => void; ms: number }> = [];
        superviseReapLoop({
            run: () => {
                calls += 1;
                return Promise.reject(new Error("db down"));
            },
            intervalMs: 5000,
            scheduleRetry: (fn, ms) => scheduled.push({ fn, ms }),
        });
        await flush();

        expect(calls).toBe(1);
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.ms).toBe(5000);
    });

    test("invoking the scheduled retry genuinely runs the loop again", async () => {
        let calls = 0;
        const scheduled: Array<() => void> = [];
        superviseReapLoop({
            run: () => {
                calls += 1;
                // Reject once (DB not up yet), then succeed (runtime healed).
                return calls === 1 ? Promise.reject(new Error("db down")) : Promise.resolve(undefined);
            },
            intervalMs: 1000,
            scheduleRetry: (fn) => scheduled.push(fn),
        });
        await flush();
        expect(calls).toBe(1);
        expect(scheduled).toHaveLength(1);

        scheduled[0]?.();
        expect(calls).toBe(2);
    });

    test("repeated failures keep re-arming - it must never give up after one retry", async () => {
        let calls = 0;
        const scheduled: Array<() => void> = [];
        superviseReapLoop({
            run: () => {
                calls += 1;
                return Promise.reject(new Error("still down"));
            },
            intervalMs: 1000,
            scheduleRetry: (fn) => scheduled.push(fn),
        });

        for (let i = 1; i <= 4; i += 1) {
            await flush();
            expect(calls).toBe(i);
            expect(scheduled).toHaveLength(1);
            const next = scheduled.pop();
            next?.();
        }
    });

    test("reports the rejection reason via onError", async () => {
        const errors: unknown[] = [];
        superviseReapLoop({
            run: () => Promise.reject(new Error("boom")),
            intervalMs: 1000,
            scheduleRetry: () => undefined,
            onError: (err) => errors.push(err),
        });
        await flush();

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
        expect((errors[0] as Error).message).toBe("boom");
    });
});

describe("runReapSchedule", () => {
    test("runs the first tick without waiting for an interval", async () => {
        let calls = 0;
        await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(runReapSchedule(Effect.sync(() => { calls += 1; }), 300));
                yield* TestClock.adjust(Duration.zero);
                expect(calls).toBe(1);
                yield* Fiber.interrupt(fiber);
            }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
        );
    });

    test("keeps sweeping on each interval", async () => {
        let calls = 0;
        await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(runReapSchedule(Effect.sync(() => { calls += 1; }), 300));
                yield* TestClock.adjust(Duration.zero);
                expect(calls).toBe(1);
                yield* TestClock.adjust(Duration.minutes(5));
                expect(calls).toBe(2);
                yield* TestClock.adjust(Duration.minutes(5));
                expect(calls).toBe(3);
                yield* Fiber.interrupt(fiber);
            }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
        );
    });

    test("a failing DB does not kill the loop - the next tick still sweeps", async () => {
        let calls = 0;
        const tick = Effect.suspend(() => {
            calls += 1;
            return calls === 1
                ? Effect.fail(new DbError({ operation: "query", message: "connection refused" }))
                : Effect.void;
        });
        await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(runReapSchedule(tick, 300));
                yield* TestClock.adjust(Duration.zero);
                expect(calls).toBe(1);
                yield* TestClock.adjust(Duration.minutes(5));
                expect(calls).toBe(2);
                yield* Fiber.interrupt(fiber);
            }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
        );
    });
});
