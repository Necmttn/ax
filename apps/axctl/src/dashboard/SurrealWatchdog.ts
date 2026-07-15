/**
 * Real-query watchdog for the managed SurrealDB process.
 *
 * The 4-day production incident: SurrealDB held its LISTEN socket while
 * refusing to answer queries. KeepAlive only restarts on process *exit* - a
 * wedge never exits, so nothing recovered. This watchdog detects the wedge
 * via a real query round-trip (not `/health`, which passes on a wedge) and
 * force-restarts via SIGKILL.
 *
 * Design:
 *   - Pure / TestClock-drivable: no wall-clock imports, only `Effect.sleep`
 *     and `Ref` for state.
 *   - The loop body: sleep(interval) → probe → update counter → maybe trip.
 *   - Sleep-first so the first probe fires at t=interval, not t=0 (lets the
 *     managed process settle before the first check).
 *   - `probe` returning false OR failing (e.g. timeout, connection refused)
 *     both count as "not ok".
 *   - After a trip, the counter resets to 0 so the watchdog re-arms and will
 *     detect a subsequent wedge after the restart.
 */
import { Duration, Effect, Ref } from "effect";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SurrealWatchdogOpts {
    /**
     * Effect that probes the database.
     *
     * - Returns `true`  → DB is responsive; success resets the failure counter.
     * - Returns `false` → DB did not answer satisfactorily; increments counter.
     * - Fails with any error → treated the same as returning `false`.
     *
     * The error channel is `unknown` so callers can pass any probe effect
     * without needing to coerce errors first; the watchdog handles all
     * failures via `Effect.orElseSucceed(() => false)`.
     *
     * The caller is responsible for supplying a 1-second hard timeout around
     * the probe so that a wedged DB does not stall the loop indefinitely.
     */
    readonly probe: Effect.Effect<boolean, unknown>;

    /**
     * Effect executed when `failuresToTrip` consecutive failures are detected.
     *
     * In production this SIGKILLs the wedged surreal pid and re-spawns it.
     * Must not throw / fail in ways that stop the watchdog (the outer loop
     * wraps it with `Effect.ignore`).
     */
    readonly onWedged: Effect.Effect<void>;

    /** Wait this long between probes. */
    readonly interval: Duration.Duration;

    /**
     * Number of consecutive probe failures needed to fire `onWedged`.
     * Reset to 0 after each trip and after each successful probe.
     */
    readonly failuresToTrip: number;
}

/**
 * Returns an infinite Effect that implements the watchdog loop.
 *
 * Callers should `Effect.fork` or `Effect.forkScoped` the result so it runs
 * as a background fiber.  Interrupting the fiber stops the watchdog cleanly.
 *
 * The returned Effect has no service requirements: all dependencies (probe,
 * onWedged) are provided by the caller via the options record.
 *
 * @example
 * ```typescript
 * yield* Effect.forkScoped(makeSurrealWatchdog({
 *   probe: probeSelect1,
 *   onWedged: killAndRespawn,
 *   interval: Duration.seconds(15),
 *   failuresToTrip: 3,
 * }));
 * ```
 */
export const makeSurrealWatchdog = (
    opts: SurrealWatchdogOpts,
): Effect.Effect<never> =>
    Ref.make(0).pipe(
        Effect.flatMap((counter) =>
            Effect.forever(
                Effect.gen(function* () {
                    // Sleep first so the first probe fires after one interval,
                    // giving the managed process time to settle.
                    yield* Effect.sleep(opts.interval);

                    // Treat both probe failure and probe returning false as "not ok".
                    const ok = yield* opts.probe.pipe(
                        Effect.map(Boolean),
                        Effect.orElseSucceed(() => false),
                    );

                    if (ok) {
                        // Healthy response - reset the failure streak.
                        yield* Ref.set(counter, 0);
                    } else {
                        const failures = yield* Ref.updateAndGet(counter, (n) => n + 1);
                        if (failures >= opts.failuresToTrip) {
                            // Trip the watchdog.
                            yield* opts.onWedged.pipe(Effect.ignore);
                            // Re-arm: reset counter so we detect the *next* wedge too.
                            yield* Ref.set(counter, 0);
                        }
                    }
                }),
            ),
        ),
    );
