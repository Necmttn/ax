import type { StageRegistryShape } from "./registry.ts";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";

/** Return the stages with these keys, in registry order. Throws on an unknown
 *  key - replaces the legacy `selectStages` helper. */
export const selectByKeys = (
    registry: StageRegistryShape,
    keys: ReadonlyArray<string>,
): ReadonlyArray<StageDef<BaseStageStats, unknown>> => {
    const all = registry.all();
    const known = new Set(all.map((s) => s.meta.key));
    const bad = keys.filter((k) => !known.has(k));
    if (bad.length > 0) {
        throw new Error(
            `ingest pipeline: unknown stage(s): ${bad.join(", ")}\n` +
                `  valid stages: ${all.map((s) => s.meta.key).join(", ")}`,
        );
    }
    const wanted = new Set(keys);
    return all.filter((s) => wanted.has(s.meta.key));
};

/** Return the stages carrying the given tag, in registry order. */
export const selectByTag = (
    registry: StageRegistryShape,
    tag: IngestStageTag,
): ReadonlyArray<StageDef<BaseStageStats, unknown>> =>
    registry.byTag(tag);
