import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import type { SurrealClientShape } from "@ax/lib/db";
import {
    PRODUCED_BY_SESSION_SQL,
    SKILL_LAST_PROJECT_SQL,
    SKILL_SUMMARY_PROPOSED_ONLY_SQL,
    SKILL_SUMMARY_SQL,
} from "../queries.ts";

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

interface SkillSummaryRawRow extends SkillRow {
    readonly corrections?: number;
    readonly proposals?: number;
    readonly skill_sessions?: ReadonlyArray<unknown>;
}

interface ProducedBySessionRow {
    readonly session?: unknown;
    readonly commits_after?: number;
}

interface LastProjectRow {
    readonly name?: string;
    readonly project?: string | null;
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
                    client.query<[Array<SkillSummaryRawRow>]>(SKILL_SUMMARY_SQL),
                    client.query<[Array<SkillRow>]>(SKILL_SUMMARY_PROPOSED_ONLY_SQL),
                    client.query<[Array<ProducedBySessionRow>]>(PRODUCED_BY_SESSION_SQL),
                    client.query<[Array<LastProjectRow>]>(SKILL_LAST_PROJECT_SQL),
                ],
                { concurrency: 4 },
            ),
        )
            .then(([invokedResult, proposedResult, producedResult, lastProjectResult]) => {
                if (cancelled || !aliveRef.current) return;
                const commitCountsBySession = buildCommitCountsBySession(producedResult?.[0] ?? []);
                const lastProjectBySkill = buildLastProjectBySkill(lastProjectResult?.[0] ?? []);
                const invokedRows = ((invokedResult?.[0] ?? []) as Array<SkillSummaryRawRow>)
                    .map((row) => enrichSkillRow(row, commitCountsBySession, lastProjectBySkill));
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

const recordKey = (value: unknown): string | null => {
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && "toString" in value) {
        const text = String(value);
        return text.length > 0 ? text : null;
    }
    return null;
};

const buildCommitCountsBySession = (
    rows: ReadonlyArray<ProducedBySessionRow>,
): Map<string, number> => {
    const out = new Map<string, number>();
    for (const raw of rows) {
        const session = recordKey(raw.session);
        if (!session) continue;
        out.set(session, Number(raw.commits_after ?? 0));
    }
    return out;
};

const buildLastProjectBySkill = (
    rows: ReadonlyArray<LastProjectRow>,
): Map<string, string> => {
    const out = new Map<string, string>();
    for (const raw of rows) {
        if (!raw.name || !raw.project || out.has(raw.name)) continue;
        out.set(raw.name, raw.project);
    }
    return out;
};

const enrichSkillRow = (
    row: SkillSummaryRawRow,
    commitCountsBySession: ReadonlyMap<string, number>,
    lastProjectBySkill: ReadonlyMap<string, string>,
): SkillRow => {
    const sessions = Array.isArray(row.skill_sessions)
        ? row.skill_sessions.map(recordKey).filter((v): v is string => v !== null)
        : [];
    const commitsAfter = sessions.reduce(
        (sum, session) => sum + (commitCountsBySession.get(session) ?? 0),
        0,
    );
    const totalInv = Number(row.total_inv ?? 0);
    const corrections = Number(row.corrections ?? 0);
    const proposals = Number(row.proposals ?? 0);
    return {
        ...row,
        taste_score: totalInv - 2 * corrections + commitsAfter - 0.5 * proposals,
        // Preserve the extra field for callers that already tolerate it,
        // without adding it to the public SkillRow interface.
        last_project: lastProjectBySkill.get(row.name) ?? null,
    } as SkillRow;
};
