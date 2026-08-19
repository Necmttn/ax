/**
 * Seed `classifier_weights` from the committed constants (#911, Phase 5
 * landed slice). Called from the ingest run tail (run.ts) alongside
 * `buildFtsIndexes` - a small idempotent bookkeeping write, not a stage
 * (nothing here is derived from transcripts). See judgment-weights.ts for the
 * seed's full provenance; `classifyTurn`'s DEFAULT path never reads this
 * table, only `AX_JUDGMENT_MODEL=learned` does (routability.ts).
 *
 * Idempotent by (model_id, version): DELETE any row for this model_id whose
 * version differs from the seed's (a stale fit never lingers next to a fresh
 * one - matters when a refit DROPS a feature, since `put` upserting by `id`
 * alone would otherwise leave that feature's old row stranded), then
 * `putMany` the seed's rows keyed by `id = <model_id>__<feature>` - an
 * INSERT-OR-REPLACE, so re-running the SAME version is a harmless no-op
 * (same id, same values) rather than needing a separate existence check.
 */
import { Effect } from "effect";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { JUDGMENT_MODEL_SEED, type JudgmentModelSeed } from "../queries/judgment-weights.ts";

export type SeedClassifierWeightsError = CacheWriteError;

/** `<model_id>__<feature>` - the same `__`-join-of-parts id shape as
 *  ingest_stage's `run__source__stage` (this schema has no composite PKs;
 *  every table is keyed by one `id VARCHAR PRIMARY KEY`). */
export const classifierWeightRowId = (modelId: string, feature: string): string => `${modelId}__${feature}`;

/** `seed` defaults to the committed {@link JUDGMENT_MODEL_SEED}; overridable
 *  only so tests can exercise the version-replace path without a second
 *  committed constants module. */
export const seedClassifierWeights = Effect.fn("ingest.seedClassifierWeights")(
    function* (write: CacheWriteService, seed: JudgmentModelSeed = JUDGMENT_MODEL_SEED) {
        yield* write.exec(
            `DELETE FROM classifier_weights WHERE model_id = ? AND version <> ?`,
            [seed.modelId, seed.version],
        );

        yield* write.putMany(
            "classifier_weights",
            Object.entries(seed.weights).map(([feature, weight]) => ({
                id: classifierWeightRowId(seed.modelId, feature),
                model_id: seed.modelId,
                feature,
                weight,
                threshold: seed.threshold,
                version: seed.version,
                trained_at: seed.trainedAt,
            })),
        );
    },
);
