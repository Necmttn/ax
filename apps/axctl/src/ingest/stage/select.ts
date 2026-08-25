import type { IngestStageError, StageRegistryShape } from "./registry.ts";
import type { IngestStageTag } from "./tags.ts";
import type { BaseStageStats, StageDef } from "./types.ts";

/** Return the stages with these keys, in registry order. Throws on an unknown
 *  key - replaces the legacy `selectStages` helper. */
export const selectByKeys = (
    registry: StageRegistryShape,
    keys: ReadonlyArray<string>,
): ReadonlyArray<StageDef<BaseStageStats, unknown, IngestStageError>> => {
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
): ReadonlyArray<StageDef<BaseStageStats, unknown, IngestStageError>> =>
    registry.byTag(tag);

/**
 * The cold-start FIRST-VALUE phase (#833): every stage marked
 * `meta.firstValue === true` in `stages`, plus their transitive deps -
 * walked within `stages` ONLY, so a caller's own selection (`--stages=`,
 * `--derive-only`) is respected rather than reached around. A dep that was
 * filtered out of `stages` upstream is silently skipped, exactly like
 * `runPipeline`'s own dep-await does (it only waits on deps present in the
 * stage set it was given).
 *
 * Returned in `stages`' original relative order - already topologically
 * sound for `runPipeline` (deps precede dependents in every real stage
 * list), and preserving it keeps this a pure filter rather than a second
 * sort with its own chance to disagree with the registry.
 */
export const firstValuePhaseStages = <S extends BaseStageStats, R, E>(
    stages: ReadonlyArray<StageDef<S, R, E>>,
): ReadonlyArray<StageDef<S, R, E>> => {
    const byKey = new Map(stages.map((s) => [s.meta.key, s] as const));
    const included = new Set<string>();
    const visit = (key: string): void => {
        if (included.has(key)) return;
        const found = byKey.get(key);
        if (found === undefined) return;
        included.add(key);
        for (const dep of found.meta.deps) visit(dep);
    };
    for (const s of stages) {
        if (s.meta.firstValue === true) visit(s.meta.key);
    }
    return stages.filter((s) => included.has(s.meta.key));
};
