import { Layer } from "effect";
import { AxConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";
import { LiveTraceLayer } from "./live-traces/Tracer.ts";
import { TraceSinkLive } from "./live-traces/Sink.ts";
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
export const AppLayer = SurrealClientLive.pipe(
    Layer.provideMerge(AxConfigLive),
    Layer.merge(ProcessServiceLive),
    Layer.provideMerge(LiveTraceLayer),
    Layer.provideMerge(TraceSinkLive({ flushIntervalMs: 200 })),
    Layer.provideMerge(NoopTransportLayer),
);
