import { Effect, PlatformError } from "effect";
import type { BaseStageStats } from "./stage/types.ts";

/** Skip one provider stage after a typed filesystem failure. */
export const skipPlatformStage = <A extends BaseStageStats>(
    provider: string,
    error: PlatformError.PlatformError,
    stats: (error: PlatformError.PlatformError) => A,
): Effect.Effect<A> =>
    Effect.logWarning(`ingest: ${provider} stage skipped because of a filesystem error`, {
        provider,
        error: error.message,
    }).pipe(Effect.as(stats(error)));
