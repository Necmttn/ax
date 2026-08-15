import { Layer } from "effect";
import { AppLayer, appLayerWithTransport } from "@ax/lib/layers";
import type { TraceTransportTag } from "@ax/lib/live-traces/Sink";
import { StageRegistryDefault } from "./registry.ts";
import { AgentSourceRegistryLive } from "../../agents/registry.ts";

/** Stage-source registries some stages depend on (e.g. agentDefStage needs AgentSourceRegistry). */
const StageSourceLayers = AgentSourceRegistryLive;

/**
 * Production runtime layer for the Ingest Pipeline. Composes the library
 * `AppLayer` with the canonical `StageRegistryDefault`. CLI ingest entry
 * points should consume this; library code that does not need the stage
 * registry should keep consuming `AppLayer` directly.
 */
export const IngestRuntimeLayer = Layer.mergeAll(AppLayer, StageRegistryDefault, StageSourceLayers);

/**
 * Ingest runtime whose `TraceSink` flushes to `transport` (e.g. the progress
 * animation or `--debug` console). Needed because trace events are dropped
 * unless the transport is wired beneath the sink - see `appLayerWithTransport`.
 */
export const ingestRuntimeLayerWith = (transport: Layer.Layer<TraceTransportTag>) =>
    Layer.mergeAll(appLayerWithTransport(transport), StageRegistryDefault, StageSourceLayers);
