import { Context, Layer, Schema } from "effect";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";

export type { StageDef } from "./types.ts";

/** Composed union of every known Ingest Stage key. Each stage file exports its
 *  own `Schema.Literal("<key>")`; this union is reassembled by re-exporting
 *  them here. Adding a stage = one import + one entry in the union below.
 *
 *  Currently a one-arm placeholder until Task 6 migrates the `skills` stage.
 *  Subsequent stage-migration tasks replace this with the real union. */
export const IngestStageKey = Schema.Literal("skills");
export type IngestStageKey = typeof IngestStageKey.Type;

export interface StageRegistryShape {
    readonly all: () => ReadonlyArray<StageDef<BaseStageStats, unknown>>;
    readonly byKey: (key: string) => StageDef<BaseStageStats, unknown> | undefined;
    readonly byTag: (tag: IngestStageTag) => ReadonlyArray<StageDef<BaseStageStats, unknown>>;
}

export class StageRegistry extends Context.Service<StageRegistry, StageRegistryShape>()(
    "ax/StageRegistry",
) {}

/** Provide a registry by passing the typed list of co-located stage definitions. */
export const StageRegistryLive = (
    stages: ReadonlyArray<StageDef<BaseStageStats, unknown>>,
): Layer.Layer<StageRegistry> =>
    Layer.succeed(StageRegistry, {
        all: () => stages,
        byKey: (key) => stages.find((s) => s.meta.key === key),
        byTag: (tag) => stages.filter((s) => s.meta.tags.includes(tag)),
    });
