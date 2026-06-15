/**
 * Legacy entry point. The pipeline implementation moved to `./stage/runner.ts`
 * and the registry to `./stage/registry.ts`. This file re-exports the
 * canonical surface for any callers that still import from
 * `src/ingest/pipeline.ts`. Prefer the canonical paths.
 */
export { runPipeline, topoLayers, PIPELINE_CONCURRENCY } from "./stage/runner.ts";
export {
    StageRegistry,
    StageRegistryDefault,
    StageRegistryLive,
    ALL_STAGES,
    type IngestStageKey,
    type StageDef,
} from "./stage/registry.ts";
export {
    BaseStageStats,
    IngestContext,
    StageMeta,
} from "./stage/types.ts";
