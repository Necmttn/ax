import { Layer } from "effect";
import { AxConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";
import { LiveTraceLayer } from "./live-traces/Tracer.ts";
import { TraceSinkLive, TraceTransportTag } from "./live-traces/Sink.ts";
import { NoopTransportLayer } from "./live-traces/transports/console.ts";

/**
 * Library-level composed application layer.
 *
 * Build order (outer → inner):
 *   1. NoopTransportLayer - silent default; drops trace events on the floor
 *      so stdout stays clean for machine-readable output (e.g. `--progress=json`).
 *      CLI entrypoints layer `ConsoleTransportLayer` on top when `--debug` is set.
 *   2. TraceSinkLive - buffered sink + flush daemon over the transport
 *   3. LiveTraceLayer - Effect tracer decorator that emits to the sink
 *   4. SurrealClient, AxConfig, ProcessService - library services
 *
 * The Ingest Stage registry is NOT included here. CLI entrypoints compose
 * `StageRegistryDefault` on top of `AppLayer` via `IngestRuntimeLayer`.
 * Keeping the registry out of this module prevents loading 15 stage source
 * files at library import time.
 */
/**
 * AppLayer minus the trace transport: `TraceTransportTag` stays an UNMET
 * requirement so the caller decides which transport `TraceSinkLive` flushes to.
 * This is the seam that makes the `--debug` console and the `ax ingest`
 * progress animation actually receive events - merging a transport on top of a
 * fully-built `AppLayer` does NOT rewire the already-constructed sink, so the
 * transport must be provided here, beneath the sink.
 */
const AppLayerSansTransport = SurrealClientLive.pipe(
    Layer.provideMerge(AxConfigLive),
    Layer.merge(ProcessServiceLive),
    Layer.provideMerge(LiveTraceLayer),
    Layer.provideMerge(TraceSinkLive({ flushIntervalMs: 200 })),
);

/** Default app layer: trace events are dropped (NoopTransport), keeping stdout
 *  clean for machine-readable output. */
export const AppLayer = AppLayerSansTransport.pipe(Layer.provideMerge(NoopTransportLayer));

/**
 * App layer whose `TraceSink` flushes to `transport`. Use this (not
 * `Layer.provideMerge(AppLayer, transport)`, which is a no-op) when trace
 * events must surface - e.g. the CLI ingest progress animation or `--debug`.
 */
export const appLayerWithTransport = (transport: Layer.Layer<TraceTransportTag>) =>
    AppLayerSansTransport.pipe(Layer.provideMerge(transport));
