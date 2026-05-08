import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import type { SurrealClientShape } from "../../lib/db.ts";
import { SKILL_SUMMARY_SQL, SKILL_SUMMARY_PROPOSED_ONLY_SQL } from "../queries.ts";

export interface SkillRow {
    readonly name: string;
    readonly scope: string;
    readonly description: string | null;
    readonly bytes: number | null;
    readonly total_inv: number;
    readonly inv_7d: number;
    readonly inv_30d: number;
    readonly last_used: string | null;
    readonly taste_score: number;
}

export interface SkillsState {
    readonly data: ReadonlyArray<SkillRow>;
    readonly loading: boolean;
    readonly error: string | null;
    readonly refresh: () => void;
}

/**
 * Fetch the skill-summary list. Re-runs on `refreshTick` changes (used by
 * the polling fallback) and once on mount. Filtering is done in-memory by
 * the caller - re-querying on every keystroke would dominate latency for
 * the small skill counts we expect (low hundreds).
 */
export function useSkills(client: SurrealClientShape): SkillsState {
    const [data, setData] = useState<ReadonlyArray<SkillRow>>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);
    const aliveRef = useRef(true);

    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        // Two queries because SurrealDB can't UNION SELECTs and the
        // GROUP BY scan over `invoked` (the fast path post-#31) doesn't
        // see skills that only have `proposed` edges. Both queries run
        // in one round-trip from the SDK's perspective; the second is
        // cheap (~tens of ms).
        Effect.runPromise(
            Effect.all(
                [
                    client.query<[Array<SkillRow>]>(SKILL_SUMMARY_SQL),
                    client.query<[Array<SkillRow>]>(SKILL_SUMMARY_PROPOSED_ONLY_SQL),
                ],
                { concurrency: 2 },
            ),
        )
            .then(([invokedResult, proposedResult]) => {
                if (cancelled || !aliveRef.current) return;
                const invokedRows = (invokedResult?.[0] ?? []) as Array<SkillRow>;
                const proposedRows = (proposedResult?.[0] ?? []) as Array<SkillRow>;
                const rows = [...invokedRows, ...proposedRows].sort((a, b) => {
                    const ds = (b.taste_score ?? 0) - (a.taste_score ?? 0);
                    if (ds !== 0) return ds;
                    const d30 = (b.inv_30d ?? 0) - (a.inv_30d ?? 0);
                    if (d30 !== 0) return d30;
                    return (b.total_inv ?? 0) - (a.total_inv ?? 0);
                });
                // Coerce dates from RecordId/Date to ISO string so render code
                // can treat the field as a primitive.
                const normalised = rows.map((r) => ({
                    ...r,
                    last_used:
                        r.last_used == null
                            ? null
                            : typeof r.last_used === "string"
                              ? r.last_used
                              : new Date(r.last_used as unknown as string).toISOString(),
                }));
                // OpenTUI's react-reconciler only commits to the renderer
                // when the React event loop hands control back. Async state
                // updates from outside an event handler need an explicit
                // flushSync, otherwise the screen sticks on the previous
                // frame until the next keypress.
                flushSync(() => {
                    setData(normalised);
                    setError(null);
                    setLoading(false);
                });
            })
            .catch((err: unknown) => {
                if (cancelled || !aliveRef.current) return;
                flushSync(() => {
                    setError(err instanceof Error ? err.message : String(err));
                    setLoading(false);
                });
            });
        return () => {
            cancelled = true;
        };
    }, [client, tick]);

    return {
        data,
        loading,
        error,
        refresh: () => setTick((t) => t + 1),
    };
}
