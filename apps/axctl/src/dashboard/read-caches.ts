import { Effect } from "effect";
import { fetchNextActions } from "./next-actions.ts";
import { fetchSkillTriage } from "./triage.ts";
import { makeTtlCachedFetch } from "./ttl-cache.ts";

/**
 * TTL caches for the remaining expensive read endpoints. Mutations
 * invalidate so their effects are visible on the next fetch:
 *   - improve accept/reject/verdict -> next-actions (proposal/verdict cards)
 *   - skills decide/clear           -> skills triage AND next-actions
 *                                      (skill-hygiene cards)
 * Ingest-driven drift is covered by the TTLs.
 */
const nextActions = makeTtlCachedFetch(
    "nextActions",
    () => fetchNextActions(),
    "5 minutes",
);
const skillTriage = makeTtlCachedFetch(
    "skillTriage",
    () => fetchSkillTriage(),
    "5 minutes",
);

export const fetchNextActionsCached = nextActions.fetch;
export const fetchSkillTriageCached = skillTriage.fetch;

/** After an improve mutation (accept/reject/verdict). */
export const invalidateNextActionsCache = nextActions.invalidate;

/** After a skill decision changes (decide / decide-bulk / clear). */
export const invalidateSkillCaches = Effect.fn("dashboard.invalidateSkillCaches")(
    function* () {
        yield* skillTriage.invalidate();
        yield* nextActions.invalidate();
    },
);

/** Test seam. */
export function resetReadCachesForTest(): void {
    nextActions.resetForTest();
    skillTriage.resetForTest();
}
