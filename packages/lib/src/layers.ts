import { Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { AxConfigLive } from "./config.ts";
import { SurrealClientLive } from "./db.ts";
import { ProcessServiceLive } from "./process.ts";
import { LiveTraceLayer } from "./live-traces/Tracer.ts";
import { TraceSinkLive, TraceTransportTag } from "./live-traces/Sink.ts";
import { NoopTransportLayer } from "./live-traces/transports/console.ts";
import { otlpTelemetryFromEnv } from "./otel.ts";

/**
 * Library-level composed application layer.
 *
 * Build order (outer → inner):
 *   1. NoopTransportLayer - silent default; drops trace events on the floor
 *      so stdout stays clean for machine-readable output (e.g. `--progress=json`).
 *      CLI entrypoints layer `ConsoleTransportLayer` on top when `--debug` is set.
 *   2. TraceSinkLive - buffered sink + flush daemon over the transport
 *   3. LiveTraceLayer - Effect tracer decorator that emits to the sink
 *   4. AxConfig, ProcessService - library services
 *
 * NO `SurrealClient` (wave 3, `c-ingest-cutover`). It used to sit at the bottom
 * of this stack, which meant EVERY consumer of `AppLayer` opened a SurrealDB
 * websocket on the way in - including `ax ingest`, which by then wrote nothing
 * but DuckDB. A command that still executes SurrealQL now merges
 * `SurrealClientLive` (`@ax/lib/db`) explicitly at its own composition site, so
 * "does this surface still need SurrealDB?" is answerable by reading one line
 * rather than inferred from an ambient layer. `c-surreal-delete` (wave 3's last
 * chunk) removes the remaining merge sites together with the client itself.
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
// Bun-backed FileSystem + Path: the seam every config-front-door mutator
// (`ax hooks/skills/agents`) writes through (see @ax/lib/atomic-write), AND the
// dependency `AxConfigLive` now needs to read the persisted runtime endpoint
// from `runtime.json` at acquisition. Merged into the platform base so the same
// instances satisfy both `AxConfig`'s build and downstream consumers.
const PlatformLive = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

// Provide FS+Path BENEATH AxConfig so its build is satisfied, while
// `provideMerge` re-exposes them so consumers still see FileSystem + Path.
const AxConfigProvided = AxConfigLive.pipe(Layer.provideMerge(PlatformLive));

const AppLayerSansTransport = AxConfigProvided.pipe(
    Layer.merge(ProcessServiceLive),
    Layer.provideMerge(LiveTraceLayer),
    Layer.provideMerge(TraceSinkLive({ flushIntervalMs: 200 })),
    // OTLP export (AX_OTLP_URL): provided BENEATH LiveTraceLayer so its build
    // sees the OTLP tracer as the base it decorates - both sinks get every span.
    Layer.provideMerge(otlpTelemetryFromEnv()),
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

/**
 * `AppLayer` PLUS a live `SurrealClient` - the transitional layer for the
 * surfaces that still execute SurrealQL.
 *
 * Named for what it is so it can be found and deleted: `git grep
 * LegacySurrealAppLayer` enumerates every remaining composition site that opens
 * a SurrealDB websocket, which `git grep AppLayer` no longer does. Wave 3's
 * read chunks shrink this list; `c-surreal-delete` empties it and removes this
 * export together with `SurrealClientLive`.
 *
 * `SurrealClientLive` needs `AxConfig`, so it is `provideMerge`d ON TOP of
 * `AppLayer` rather than merged beside it - `Layer.mergeAll` builds in
 * parallel and would leave that dependency unsatisfied.
 */
export const LegacySurrealAppLayer = SurrealClientLive.pipe(Layer.provideMerge(AppLayer));
