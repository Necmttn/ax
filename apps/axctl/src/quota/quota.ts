/**
 * Quota orchestrator: cache-first read of the Anthropic plan-usage windows.
 *
 * Resolution order: fresh cache -> live fetch (then cache it) -> stale cache
 * as a degraded fallback when the fetch fails (so the statusline doesn't
 * flap on transient network errors). Token-missing and hard fetch failures
 * with no cache surface as typed errors for the CLI layer to render.
 */
import { Effect, Schema } from "effect";
import { isFresh, loadQuotaCache, saveQuotaCache } from "./cache.ts";
import { QuotaApiError, QuotaEnv } from "./quota-env.ts";
import { toQuotaSnapshot, type QuotaSnapshot } from "./schema.ts";

export class QuotaTokenMissing extends Schema.TaggedErrorClass<QuotaTokenMissing>(
    "QuotaTokenMissing",
)("QuotaTokenMissing", {}) {}

export type QuotaSource = "cache" | "live" | "stale-cache";

export interface QuotaResult {
    readonly snapshot: QuotaSnapshot;
    readonly source: QuotaSource;
}

export interface GetQuotaOptions {
    readonly cachePath: string;
    /** Cache TTL in seconds; 0 forces a live fetch. */
    readonly maxAgeSeconds: number;
    readonly nowMs: number;
}

export const getQuota = (
    options: GetQuotaOptions,
): Effect.Effect<QuotaResult, QuotaTokenMissing | QuotaApiError, QuotaEnv> =>
    Effect.gen(function* () {
        const cached = yield* Effect.promise(() => loadQuotaCache(options.cachePath));
        if (cached !== null && isFresh(cached, options.nowMs, options.maxAgeSeconds)) {
            return { snapshot: cached, source: "cache" as const };
        }

        const env = yield* QuotaEnv;
        const token = yield* env.readToken();
        if (token === null) {
            // A stale cache beats an error for render-only callers.
            if (cached !== null) return { snapshot: cached, source: "stale-cache" as const };
            return yield* Effect.fail(new QuotaTokenMissing({}));
        }

        const fetched = yield* env.fetchUsage(token).pipe(
            Effect.map((raw) => toQuotaSnapshot(raw, new Date(options.nowMs).toISOString())),
            Effect.catch((error) =>
                cached !== null ? Effect.succeed(null) : Effect.fail(error),
            ),
        );
        if (fetched === null) {
            if (cached !== null) return { snapshot: cached, source: "stale-cache" as const };
            return yield* Effect.fail(
                new QuotaApiError({ status: 0, message: "usage endpoint returned an unrecognized shape" }),
            );
        }

        // Cache-write failure must not break a successful read.
        yield* Effect.promise(async () => {
            try {
                await saveQuotaCache(options.cachePath, fetched);
            } catch {
                // degraded: next call refetches
            }
        });
        return { snapshot: fetched, source: "live" as const };
    });
