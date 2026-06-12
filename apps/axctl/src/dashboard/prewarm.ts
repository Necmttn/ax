import { Effect } from "effect";
import { fetchNextActionsCached, fetchSkillTriageCached } from "./read-caches.ts";
import { fetchWrappedCached } from "./wrapped-cache.ts";

/**
 * Fire-and-forget boot sweep over the expensive cached read paths so the
 * first visitor lands on hot caches instead of paying the compute:
 *   - wrapped profile (~20s full-graph pass) - the landing page
 *   - next actions   (~4s, churn leg timeout-bound)
 *   - skill triage   (~2.5s)
 * Per-leg fail-open: a failing prewarm just means that endpoint's first
 * caller pays the compute. Concurrency 2 keeps boot from hammering the DB.
 */
export const prewarmDashboardCaches = Effect.fn("dashboard.prewarm")(function* () {
    yield* Effect.all(
        [
            fetchWrappedCached().pipe(Effect.ignore),
            fetchNextActionsCached().pipe(Effect.ignore),
            fetchSkillTriageCached().pipe(Effect.ignore),
        ],
        { concurrency: 2, discard: true },
    );
});
