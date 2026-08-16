/**
 * DesktopIngestScheduler - keeps the graph fresh while the desktop app is open.
 *
 * Wave 3 (`c-desktop-realign`): `POST /api/ingest` was RETIRED when `ax serve`
 * became the ephemeral `ax studio` (studio ephemeral, wave 3 - see
 * `packages/lib/src/shared/api-contract.ts`'s "live" family retirement note).
 * `ax studio` is now a read-only view over a published DuckDB snapshot; it has
 * no write path and nothing left to POST to. So the desktop app - which,
 * unlike the CLI's launchd watcher, is the only thing that would otherwise
 * trigger ingest under the IDE daemon model (no background agent - see
 * docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md)
 * - now triggers ingest the same way the CLI itself does: spawning
 * `bun <axSourceEntry> ingest --since=<sinceDays>` as a short-lived child
 * process. Ingest publishes a fresh snapshot on completion (see
 * `packages/lib/src/duckdb/client.ts`'s `publishSnapshot`), which `ax studio`
 * picks up on its next query - no coordination between the two processes is
 * needed beyond that.
 */
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeComponentLogger } from "../app/DesktopObservability.ts";

const { logError } = makeComponentLogger("desktop-ingest-scheduler");

/** The subset of `AxBackendEnvironment` an ingest run needs to spawn `ax ingest`. */
export interface IngestEnv {
    readonly bunBinaryPath: string;
    readonly axSourceEntry: string;
    /** cwd for the spawned `ax ingest` process (the ax source root). */
    readonly axSourceRoot: string;
}

/**
 * Fire a single `ax ingest --since=<sinceDays>` run to completion. Mirrors
 * the CLI invocation exactly (no daemon involved) - stdio is discarded since
 * this runs silently in the background; a non-zero exit is logged, never
 * thrown, so one bad run can't kill the scheduling loop.
 */
export const triggerIngest = (
    env: IngestEnv,
    sinceDays: number,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const command = ChildProcess.make(
            env.bunBinaryPath,
            [env.axSourceEntry, "ingest", `--since=${sinceDays}`],
            {
                cwd: env.axSourceRoot,
                // Without this the child gets NO environment at all (not even
                // PATH/HOME) - `extendEnv` defaults to false, so an omitted
                // `env` resolves to nothing, not "inherit". `ax ingest` needs
                // the parent's env to find `AX_DATA_DIR`/`HOME` (matches
                // SupervisedProcess.ts's `runChildProcess`, which sets this
                // for the same reason).
                extendEnv: true,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
            },
        );

        yield* spawner.exitCode(command).pipe(
            Effect.tap((code) =>
                Number(code) === 0
                    ? Effect.void
                    : logError("ingest run exited non-zero", { exit: Number(code) }),
            ),
            Effect.catchCause((cause) =>
                logError("ingest run failed to spawn", { cause: Cause.pretty(cause) }),
            ),
            Effect.asVoid,
        );
    });

/** Tuning for {@link run}. */
export interface IngestSchedulerConfig {
    readonly env: IngestEnv;
    /** `--since=<sinceDays>` window passed to each ingest run. */
    readonly sinceDays: number;
    /** Gap between ingest runs while the app stays open. */
    readonly interval: Duration.Duration;
}

/**
 * Run ingest while the app is open: an immediate first run, then one every
 * `config.interval`. Never settles - the caller forks it into a scope so it is
 * interrupted on shutdown.
 */
export const run = (
    config: IngestSchedulerConfig,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
    triggerIngest(config.env, config.sinceDays).pipe(
        // A failed run must not kill the loop - triggerIngest already logs +
        // swallows spawn/exit failures, so the next tick still fires.
        Effect.repeat(Schedule.spaced(config.interval)),
        Effect.asVoid,
    );
