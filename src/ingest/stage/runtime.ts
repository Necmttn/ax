import { Layer } from "effect";
import { AppLayer } from "../../lib/layers.ts";
import { StageRegistryDefault } from "./registry.ts";

/**
 * Production runtime layer for the Ingest Pipeline. Composes the library
 * `AppLayer` with the canonical `StageRegistryDefault`. CLI ingest entry
 * points should consume this; library code that does not need the stage
 * registry should keep consuming `AppLayer` directly.
 */
export const IngestRuntimeLayer = Layer.merge(AppLayer, StageRegistryDefault);
