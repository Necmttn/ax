/**
 * Server-side ingest workflow runner.
 *
 * `startIngestWorkflow` runs {@link runIngest} IN-PROCESS, wiring a live-trace
 * {@link TraceTransport} that forwards every emitted span event to the
 * {@link IngestStreamBus}. It returns the `runId` immediately and runs the
 * pipeline on a forked daemon fiber, so the HTTP request that triggered the run
 * can return at once while progress streams to the bus.
 *
 * runId plumbing: the generated `runId` is passed to `runIngest` via the
 * existing `RunIngestOptions.runId` thunk, which makes the live trace id
 * `ingest:<runId>`. `ingestStreamEventFromTrace` strips that prefix back to
 * `<runId>`, so the stream name is known before the run starts. The CLI path is
 * unchanged: the CLI does not pass `runId`, so it keeps generating its own.
 *
 * **Single-flight (#F3)**: the run is wrapped in the SAME `ingest.lock` file
 * the CLI uses (`withIngestLock`), so a live-ingest trigger while a CLI/watcher
 * ingest already holds the lock fails fast instead of piling a second
 * concurrent ingest onto SurrealDB (the exact contention `withIngestLock` was
 * built to prevent - see ingest-lock.ts's header). A busy skip never runs
 * `runIngest` at all; it publishes a synthetic `run_finished{failed}` event
 * (same shape the early-failure path below already uses) so the stream
 * terminates cleanly instead of hanging. No `timeoutSeconds` is passed, so
 * (matching `RunIngestOptions.deadlineMs`'s own doc comment) this path stays
 * unbounded - only the CLI/`share/recover.ts` callers impose a hard cap.
 */
import { Cause, Effect, FileSystem, Layer, Path } from "effect";
import { AxConfig } from "@ax/lib/config";
import { SurrealClient } from "@ax/lib/db";
import { LiveTraceLayer } from "@ax/lib/live-traces/Tracer";
import { ProcessService } from "@ax/lib/process";
import {
    TraceSink,
    TraceSinkLive,
    TraceTransportTag,
    type TraceTransport,
} from "@ax/lib/live-traces/Sink";
import { runIngest, type RunIngestOptions } from "../ingest/run.ts";
import { ingestLockOptions, withIngestLock } from "@ax/lib/ingest-lock";
import { StageRegistry } from "../ingest/stage/registry.ts";
import { withoutCacheRead } from "../ingest/stage/runtime.ts";
import { ingestStreamEventFromTrace } from "../ingest/stream-events.ts";
import type { IngestStreamBus } from "./ingest-stream.ts";

/** Services `runIngest` (+ the single-flight lock) need that the caller must
 *  provide via `baseLayer`. `FileSystem`/`Path` are read/written for the lock
 *  file; production callers already get them from `AppLayer` (it re-exposes
 *  its Bun-backed platform layer via `provideMerge` - see packages/lib/src/layers.ts). */
export type IngestBaseServices =
    | SurrealClient
    | AxConfig
    | ProcessService
    | StageRegistry
    | FileSystem.FileSystem
    | Path.Path;

/**
 * The `baseLayer` accepted by {@link startIngestWorkflow}. It must provide
 * {@link IngestBaseServices}; any layer-build error (e.g. a `DbError` from the
 * production `IngestRuntimeLayer`) is swallowed by the workflow's `catchCause`
 * and surfaced as a synthetic terminal `run_finished{failed}` event, so the
 * error channel is intentionally unconstrained. Providing extra services
 * (e.g. `TraceSink`) is fine - they are ignored.
 */
export type IngestBaseLayer = Layer.Layer<IngestBaseServices, unknown>;

/**
 * Per-invocation terminal-event guard. The transport flips `finished` to `true`
 * once it forwards a `run_finished` event (any status), so the workflow's
 * failure handler can publish a synthetic terminal event ONLY when the normal
 * trace-driven one never arrived. Guarantees exactly one terminal event.
 */
interface TerminalState {
    finished: boolean;
}

/** A live-trace transport that forwards ingest spans to the stream bus. */
function busTransportLayer(bus: IngestStreamBus, state: TerminalState): Layer.Layer<TraceTransportTag> {
    const ctx = {
        spanNames: new Map<string, string>(),
        spanStartedAt: new Map<string, number>(),
        spanCounts: new Map<string, Record<string, number>>(),
        index: { started: 0 },
    };
    const transport: TraceTransport = {
        send: (events) =>
            Effect.promise(async () => {
                for (const event of events) {
                    const mapped = ingestStreamEventFromTrace(event, ctx);
                    if (mapped) {
                        if (mapped.kind === "run_finished") state.finished = true;
                        await bus.publish(mapped.runId, mapped);
                    }
                }
            }),
    };
    return Layer.succeed(TraceTransportTag, transport);
}

/**
 * The full live-trace stack backed by the bus transport: a TraceSink that
 * flushes to the bus, plus the LiveTraceLayer tracer that emits span events.
 */
function busTraceLayer(bus: IngestStreamBus, state: TerminalState): Layer.Layer<TraceSink> {
    const sink = TraceSinkLive({ flushIntervalMs: 50 }).pipe(
        Layer.provide(busTransportLayer(bus, state)),
    );
    return Layer.mergeAll(sink, LiveTraceLayer.pipe(Layer.provide(sink)));
}

export interface StartIngestResult {
    readonly runId: string;
}

/**
 * Start an ingest run in-process, streaming progress to `bus`.
 *
 * Returns immediately with the `runId`; the pipeline runs on a forked daemon
 * fiber. `baseLayer` must provide `runIngest`'s remaining services
 * (everything except the live-trace `TraceSink`, which this function wires).
 *
 * @remarks
 * The returned effect MUST be forked onto a long-lived runtime (e.g. a server's
 * managed runtime). Do NOT run it on a short-lived per-request
 * `Effect.runPromise`: that runtime tears down when the request resolves, which
 * would kill the detached daemon mid-run before the pipeline finishes.
 *
 * Exactly one terminal `run_finished` event is published per run:
 * - happy/normal-failure paths: the tracer emits `TraceEnd` →
 *   `run_finished{completed|failed}` via the transport.
 * - early/atypical failures (defect or `DbError` thrown before the tracer wraps
 *   the pipeline): the `catchCause` handler publishes a synthetic
 *   `run_finished{failed}` so the stream always terminates, guarded by the
 *   shared {@link TerminalState} flag to avoid a double-emit.
 */
export const startIngestWorkflow = (
    opts: RunIngestOptions,
    bus: IngestStreamBus,
    baseLayer: IngestBaseLayer,
): Effect.Effect<StartIngestResult> =>
    Effect.gen(function* () {
        const runId = crypto.randomUUID();
        // Shared, per-invocation guard (like `spanNames`): the transport sets
        // this when it forwards a `run_finished`, so the failure handler below
        // only emits a synthetic terminal event when none was published.
        const state: TerminalState = { finished: false };
        // Single-flight (#F3): the same `ingest.lock` file the CLI holds. A
        // busy skip never calls `runIngest` at all - it publishes the
        // synthetic terminal event itself (mirroring the catchCause guard
        // below) so the stream terminates cleanly instead of hanging on a
        // run that never happened.
        const lockedIngest = Effect.gen(function* () {
            const cfg = yield* AxConfig;
            const path = yield* Path.Path;
            yield* withIngestLock(
                {
                    ...ingestLockOptions(path, cfg.paths.dataDir, opts.command, cfg.knobs.ingestTimeoutSeconds),
                    // No `timeoutSeconds` - this path stays unbounded, same as
                    // before this change (see the module doc comment).
                    onBusy: (holder) =>
                        Effect.gen(function* () {
                            yield* Effect.logWarning(
                                `live ingest skipped: another ingest (pid ${holder.pid}, ` +
                                    `${holder.command}) is already running`,
                            ).pipe(Effect.annotateLogs("runId", runId));
                            if (!state.finished) {
                                state.finished = true;
                                yield* Effect.promise(() =>
                                    bus.publish(runId, {
                                        kind: "run_finished",
                                        runId,
                                        status: "failed",
                                        durationMs: 0,
                                    }),
                                );
                            }
                        }),
                },
                runIngest({ ...opts, runId: () => runId }),
            );
        });
        const program = lockedIngest.pipe(
            // F1/F2 on the DAEMON path. `serve-runtime`'s ManagedRuntime merges
            // `CacheReadLive` because the HTTP handlers read the published
            // snapshot through it - but this fiber is an INGEST run, and a
            // `CacheRead` resolved here would answer from the snapshot the
            // PREVIOUS run published. Applied inside the runtime's provide, so
            // it shadows that service for this program only; the CLI entry point
            // installs the same guard.
            withoutCacheRead,
            // Single combined provide; `provideMerge` keeps the original
            // override order (the bus-backed TraceSink wins over any TraceSink
            // a caller's baseLayer happens to carry - see IngestBaseLayer docs).
            Effect.provide(busTraceLayer(bus, state).pipe(Layer.provideMerge(baseLayer))),
            Effect.scoped,
            Effect.catchCause((cause) =>
                Effect.gen(function* () {
                    yield* Effect.logError("ingest workflow failed").pipe(
                        Effect.annotateLogs("runId", runId),
                        Effect.annotateLogs("cause", Cause.pretty(cause)),
                    );
                    // Early/atypical failure before the tracer emitted TraceEnd:
                    // publish a synthetic terminal event so the stream never hangs.
                    if (!state.finished) {
                        state.finished = true;
                        yield* Effect.promise(() =>
                            bus.publish(runId, { kind: "run_finished", runId, status: "failed", durationMs: 0 }),
                        );
                    }
                }),
            ),
        );
        // Detached daemon: outlives this effect's completion (and the HTTP
        // request that triggered it), so the pipeline streams progress to the
        // bus in the background. `startImmediately` so events begin flowing
        // without waiting for the next scheduler tick.
        yield* Effect.forkDetach(program, { startImmediately: true });
        return { runId };
    });
