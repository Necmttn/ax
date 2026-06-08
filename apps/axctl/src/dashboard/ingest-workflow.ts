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
 */
import { Cause, Effect, Layer } from "effect";
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
import { StageRegistry } from "../ingest/stage/registry.ts";
import { ingestStreamEventFromTrace } from "../ingest/stream-events.ts";
import type { IngestStreamBus } from "./ingest-stream.ts";

/** Services `runIngest` needs that the caller must provide via `baseLayer`. */
export type IngestBaseServices = SurrealClient | AxConfig | ProcessService | StageRegistry;

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
        const program = runIngest({ ...opts, runId: () => runId }).pipe(
            Effect.provide(busTraceLayer(bus, state)),
            Effect.provide(baseLayer),
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
