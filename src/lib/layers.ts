import { Layer } from "effect";
import { AxConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";
import { LiveTraceLayer } from "./live-traces/Tracer.ts";
import { TraceSinkLive } from "./live-traces/Sink.ts";
import { ConsoleTransportLayer } from "./live-traces/transports/console.ts";
import { StageRegistryDefault } from "../ingest/stage/registry.ts";

/**
 * Composed application layer.
 *
 * Layering rationale (outer → inner build order):
 *
 *   1. ConsoleTransportLayer provides the TraceTransport (overridable for tests)
 *   2. TraceSinkLive builds the buffered sink + flush daemon over the transport
 *   3. LiveTraceLayer wraps the current Effect tracer so withSpan/log calls
 *      inside `LiveTrace.withTrace` scopes emit to the sink
 *   4. SurrealClient depends on AxConfig, so it is provided via provideMerge
 *      (builds AxConfigLive first, then SurrealClientLive on top).
 *   5. ProcessService and StageRegistryDefault have no inter-dependencies and
 *      are merged in at the end.
 *
 * `Layer.provideMerge` builds the argument first, so ConsoleTransportLayer →
 * TraceSinkLive → LiveTraceLayer build in that order.
 */
export const AppLayer = SurrealClientLive.pipe(
    Layer.provideMerge(AxConfigLive),
    Layer.merge(ProcessServiceLive),
    Layer.merge(StageRegistryDefault),
    Layer.provideMerge(LiveTraceLayer),
    Layer.provideMerge(TraceSinkLive({ flushIntervalMs: 200 })),
    Layer.provideMerge(ConsoleTransportLayer),
);
