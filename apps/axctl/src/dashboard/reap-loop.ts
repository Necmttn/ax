/**
 * Periodic ingest_run reaper for the serve daemon (#697).
 *
 * `reapStaleIngestRuns` (#282/#597) sweeps crash residue, but only at INGEST
 * START. That covers the watcher model, where the next transcript write fires
 * an ingest within minutes. It does NOT cover the IDE daemon model (studio.app
 * owns surreal + serve, no LaunchAgent watcher): when ingest stops running,
 * nothing ever calls the reaper again. That is exactly how two rows sat
 * "running" from Jul 3 to Jul 16 with `ax doctor` the only thing that would
 * have said so - and doctor only runs when a human runs it.
 *
 * So: fork the same reap onto the daemon, which IS always up. The reap itself
 * is unchanged (stranded = heartbeat past ingest timeout + grace, so a live
 * concurrent run is never touched) - only the trigger is new.
 */
import { Duration, Effect, Schedule } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient } from "@ax/lib/db";
import { nonNegativeNumberEnv } from "@ax/lib/shared/env-number";
import { reapStaleIngestRuns } from "../ingest/reap-runs.ts";

/** Default gap between sweeps. Cheap (one indexed query over
 *  `status = 'running'`, normally 0-1 rows), so 5min is generous and still
 *  bounds a crashed row's lifetime to minutes instead of weeks. */
const DEFAULT_REAP_INTERVAL_SECONDS = 300;

/** `AX_REAP_INTERVAL_SECONDS`; an explicit `0` disables the loop. A blank value
 *  reads as UNSET, not disabled - see {@link nonNegativeNumberEnv}. Exported
 *  for tests. */
export const reapIntervalSeconds = (env: NodeJS.ProcessEnv = process.env): number =>
    nonNegativeNumberEnv(env.AX_REAP_INTERVAL_SECONDS, DEFAULT_REAP_INTERVAL_SECONDS);

/**
 * Sweep stranded `ingest_run` rows now, then every `intervalSeconds`. Never
 * settles - the caller forks it onto the serve runtime, which interrupts it on
 * dispose.
 *
 * Fail-open per tick: a DB blip (daemon started before surreal, connection
 * dropped) must not kill the loop, or the daemon silently stops reaping and we
 * are back to #697. Logged at debug - a transient reap failure is not something
 * a user needs on their terminal.
 */
export const runReapLoop = (opts: {
    readonly intervalSeconds: number;
}): Effect.Effect<void, never, SurrealClient | AxConfig> =>
    reapStaleIngestRuns().pipe(
        Effect.tap((result) =>
            result.reaped > 0
                ? Effect.logWarning(
                    `ax serve: reaped ${result.reaped} stranded ingest_run row(s) ` +
                        `(${result.ids.join(", ")}) - a previous ingest died without finalizing`,
                )
                : Effect.void,
        ),
        Effect.catchCause((cause) => Effect.logDebug("ax serve: ingest_run reap tick failed", cause)),
        Effect.repeat(Schedule.spaced(Duration.seconds(opts.intervalSeconds))),
        Effect.asVoid,
    );

/**
 * Re-arm `run` on rejection instead of dropping it for the daemon's whole
 * life (#697, take two). `runReapLoop`'s own `Effect.catchCause` only catches
 * failures INSIDE the effect - it can't catch a LAYER-BUILD failure (e.g.
 * SurrealDB not listening yet when the daemon boots, a documented and
 * expected race with the `com.necmttn.ax-db` LaunchAgent). Before this, that
 * rejection hit a bare `.catch(() => undefined)` at the call site: silently
 * swallowed, loop never re-forked, reaper gone for the process's entire life
 * with zero log line - the exact failure mode #697 was filed for, just moved
 * one layer up.
 *
 * `run` heals itself: `handle.runner` (serve-runtime.ts) swaps in a fresh
 * runtime after any build failure, so the NEXT invocation of `run` retries
 * the layer build fresh rather than replaying the same dead one.
 *
 * Seams are injected so this is testable without a daemon or a live DB:
 * `run` stands in for `handle.runner(runReapLoop(...))`, `scheduleRetry` for
 * `setTimeout` (the caller is expected to `.unref()` its timer so a pending
 * retry can never hold the process open at shutdown), `onError` for logging.
 */
export const superviseReapLoop = (opts: {
    readonly run: () => Promise<unknown>;
    readonly intervalMs: number;
    readonly scheduleRetry: (fn: () => void, ms: number) => void;
    readonly onError?: (err: unknown) => void;
}): void => {
    const attempt = (): void => {
        opts.run().catch((err: unknown) => {
            opts.onError?.(err);
            // Re-arm unconditionally - a run() that fails once (DB not up
            // yet) or repeatedly (DB never comes up) must keep retrying
            // forever, never give up after a single attempt.
            opts.scheduleRetry(attempt, opts.intervalMs);
        });
    };
    attempt();
};
