import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import type { SurrealClientShape } from "../../lib/db.ts";
import { SKILL_SUMMARY_SQL } from "../queries.ts";

export interface SkillRow {
    readonly name: string;
    readonly scope: string;
    readonly description: string | null;
    readonly bytes: number | null;
    readonly total_inv: number;
    readonly inv_7d: number;
    readonly inv_30d: number;
    readonly last_used: string | null;
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
        Effect.runPromise(
            client.query<[Array<SkillRow>]>(SKILL_SUMMARY_SQL),
        )
            .then((result) => {
                if (cancelled || !aliveRef.current) return;
                const rows = (result?.[0] ?? []) as Array<SkillRow>;
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
