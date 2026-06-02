import { Layer } from "effect";
import { AppLayer, appLayerWithTransport } from "@ax/lib/layers";
import type { TraceTransportTag } from "@ax/lib/live-traces/Sink";
import { StageRegistryDefault } from "./registry.ts";

/**
 * Production runtime layer for the Ingest Pipeline. Composes the library
 * `AppLayer` with the canonical `StageRegistryDefault`. CLI ingest entry
 * points should consume this; library code that does not need the stage
 * registry should keep consuming `AppLayer` directly.
 */
export const IngestRuntimeLayer = Layer.merge(AppLayer, StageRegistryDefault);

/**
 * Ingest runtime whose `TraceSink` flushes to `transport` (e.g. the progress
 * animation or `--debug` console). Needed because trace events are dropped
 * unless the transport is wired beneath the sink - see `appLayerWithTransport`.
 */
export const ingestRuntimeLayerWith = (transport: Layer.Layer<TraceTransportTag>) =>
    Layer.merge(appLayerWithTransport(transport), StageRegistryDefault);
