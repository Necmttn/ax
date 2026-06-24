/**
 * Background ingest loop for `ax serve --ingest-every=<dur>`.
 *
 * When the macOS background helper starts `ax serve --managed-db --ingest-every=2m`,
 * this module provides `runIngestLoop` which calls the same `runIngest`
 * pipeline that `POST /api/ingest` uses, on a recurring schedule. Each
 * iteration fails-soft: a crash in one ingest run is logged and the loop
 * continues rather than dying.
 *
 * The loop is forked as a detached daemon fiber (via `Effect.forkDetach`) in
 * the serve runtime's managed scope so it outlives individual HTTP requests
 * but is interrupted when the server shuts down.
 */
import { Cause, Duration, Effect, Layer, Schedule } from "effect";
import { TraceSink } from "@ax/lib/live-traces/Sink";
import { runIngest, type RunIngestOptions } from "../ingest/run.ts";
import type { IngestBaseServices } from "./ingest-workflow.ts";

/** A no-op TraceSink for background ingest runs (no live-trace bus needed). */
const noopTraceSinkLayer: Layer.Layer<TraceSink> = Layer.succeed(TraceSink, {
    emit: () => undefined,
});

// ---------------------------------------------------------------------------
// runIngestLoop
// ---------------------------------------------------------------------------

/**
 * Run the ingest pipeline on a fixed interval.
 *
 * Each iteration calls `runIngest` in-process (same pipeline as CLI /
 * POST /api/ingest) and fail-soft swallows failures so one bad run never
 * kills the loop.
 *
 * `baseLayer` must satisfy `runIngest`'s service requirements
 * (SurrealClient | AxConfig | ProcessService | StageRegistry | TraceSink).
 * Using the `IngestBaseLayer` from `ingest-workflow.ts` is recommended.
 *
 * @param opts.every     - Time between ingest runs (e.g. `Duration.minutes(2)`).
 * @param opts.sinceDays - `--since=N` window passed to each ingest run.
 *                         Defaults to 2 (pick up the last 2 days of changes).
 *
 * Returns an effect that never resolves (loops forever). Fork it with
 * `Effect.forkDetach` or `Effect.forkScoped` from inside the serve runtime.
 */
export const runIngestLoop = (
    opts: {
        readonly every: Duration.Duration;
        readonly sinceDays?: number;
    },
    baseLayer: Layer.Layer<IngestBaseServices, unknown>,
): Effect.Effect<never> => {
    const sinceDays = opts.sinceDays ?? 2;
    const everyMs = Duration.toMillis(opts.every);

    const ingestOpts: RunIngestOptions = {
        command: "ingest",
        args: [`--since=${sinceDays}`],
        cwd: process.cwd(),
    };

    const oneRun: Effect.Effect<void> = runIngest(ingestOpts).pipe(
        Effect.asVoid,
        // Provide the no-op TraceSink first (lower priority), then the
        // caller's baseLayer on top so it can override if needed.
        Effect.provide(baseLayer),
        Effect.provide(noopTraceSinkLayer),
        Effect.scoped,
        Effect.catchCause((cause) =>
            Effect.logWarning(
                "[ingest-loop] ingest iteration failed, will retry next interval",
                { cause: Cause.pretty(cause) },
            ),
        ),
    );

    // repeat(Schedule.spaced) waits `every` AFTER each run completes.
    return oneRun.pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(everyMs))),
        Effect.asVoid,
        Effect.catchCause((cause) =>
            Effect.logError("[ingest-loop] unexpected loop error", {
                cause: Cause.pretty(cause),
            }),
        ),
        Effect.flatMap(() => Effect.never),
    );
};
