import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import { daysAgoExpr } from "@ax/lib/duckdb/clause";
import type { CacheReadService } from "@ax/lib/duckdb/seam";

// Local DuckDB translations of queries/skill-summary.ts's SurrealQL
// constants (unported, 2b's ownership - copy the shape, never import the
// SurrealQL text). Mirrors the identical translation already landed in
// dashboard/triage.ts's fetchSkillTriage - the TUI hot path and the web
// dashboard's triage view compute the same skill-summary shape, but each
// chunk-owned surface carries its own local copy rather than cross-importing
// between dashboard/ and tui/.

const SKILL_SUMMARY_SQL = `
SELECT
    sk.name AS name,
    sk.scope AS scope,
    sk.description AS description,
    sk.dir_path AS dir_path,
    sk.bytes AS bytes,
    agg.total_inv AS total_inv,
    agg.inv_7d AS inv_7d,
    agg.inv_30d AS inv_30d,
    agg.last_used AS last_used,
    agg.corrections AS corrections,
    (SELECT count(*) FROM proposed p WHERE p.out_id = sk.id) AS proposals,
    COALESCE(
        (SELECT to_json(list(DISTINCT iv2.session)) FROM invoked iv2 WHERE iv2.out_id = sk.id AND iv2.session IS NOT NULL)::VARCHAR,
        '[]'
    ) AS skill_sessions
FROM (
    SELECT
        out_id AS skill_id,
        count(*) AS total_inv,
        SUM(CASE WHEN ts > ${daysAgoExpr} THEN 1 ELSE 0 END) AS inv_7d,
        SUM(CASE WHEN ts > ${daysAgoExpr} THEN 1 ELSE 0 END) AS inv_30d,
        MAX(ts) AS last_used,
        SUM(CASE WHEN was_corrected = true THEN 1 ELSE 0 END) AS corrections
    FROM invoked
    GROUP BY out_id
) agg
JOIN skill sk ON sk.id = agg.skill_id;`;

const SKILL_SUMMARY_PARAMS = [7, 30];

const SKILL_LAST_PROJECT_SQL = `
SELECT sk.name AS name, s.project AS project, iv.ts AS ts
FROM invoked iv
JOIN skill sk ON sk.id = iv.out_id
LEFT JOIN session s ON s.id = iv.session
ORDER BY iv.ts DESC
LIMIT 50000;`;

const PRODUCED_BY_SESSION_SQL = `
SELECT in_id AS session, count(*) AS commits_after
FROM produced
GROUP BY in_id
LIMIT 50000;`;

/** Skills with `proposed` edges but no `invoked` edges. Union with the main
 *  scan on the JS side. */
const SKILL_SUMMARY_PROPOSED_ONLY_SQL = `
SELECT
    sk.name AS name,
    sk.scope AS scope,
    sk.description AS description,
    sk.dir_path AS dir_path,
    sk.bytes AS bytes,
    0 AS total_inv,
    0 AS inv_7d,
    0 AS inv_30d,
    NULL AS last_used,
    0 AS corrections,
    (SELECT count(*) FROM proposed p WHERE p.out_id = sk.id) AS proposals,
    '[]' AS skill_sessions
FROM skill sk
WHERE NOT EXISTS (SELECT 1 FROM invoked iv WHERE iv.out_id = sk.id)
    AND EXISTS (SELECT 1 FROM proposed p WHERE p.out_id = sk.id)
    AND (sk.dir_path IS NULL OR sk.dir_path != '(synthetic)');`;

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
    readonly skill_sessions?: unknown;
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
export function useSkills(read: CacheReadService): SkillsState {
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
        // Two queries because the GROUP BY scan over `invoked` (the fast
        // path) doesn't see skills that only have `proposed` edges.
        Effect.runPromise(
            Effect.all(
                [
                    read.raw(SKILL_SUMMARY_SQL, SKILL_SUMMARY_PARAMS),
                    read.raw(SKILL_SUMMARY_PROPOSED_ONLY_SQL),
                    read.raw(PRODUCED_BY_SESSION_SQL),
                    read.raw(SKILL_LAST_PROJECT_SQL),
                ],
                { concurrency: 4 },
            ),
        )
            .then(([invokedResult, proposedResult, producedResult, lastProjectResult]) => {
                if (cancelled || !aliveRef.current) return;
                const commitCountsBySession = buildCommitCountsBySession(
                    (producedResult.rows as unknown) as ProducedBySessionRow[],
                );
                const lastProjectBySkill = buildLastProjectBySkill(
                    (lastProjectResult.rows as unknown) as LastProjectRow[],
                );
                const invokedRows = ((invokedResult.rows as unknown) as SkillSummaryRawRow[])
                    .map((row) => enrichSkillRow(row, commitCountsBySession, lastProjectBySkill));
                const proposedRows = (proposedResult.rows as unknown) as SkillRow[];
                const rows = [...invokedRows, ...proposedRows].sort((a, b) => {
                    const ds = (b.taste_score ?? 0) - (a.taste_score ?? 0);
                    if (ds !== 0) return ds;
                    const d30 = (b.inv_30d ?? 0) - (a.inv_30d ?? 0);
                    if (d30 !== 0) return d30;
                    return (b.total_inv ?? 0) - (a.total_inv ?? 0);
                });
                // Coerce dates from Date/BIGINT-string to ISO string so
                // render code can treat the field as a primitive.
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
    }, [read, tick]);

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

const parseSessionsJson = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const enrichSkillRow = (
    row: SkillSummaryRawRow,
    commitCountsBySession: ReadonlyMap<string, number>,
    lastProjectBySkill: ReadonlyMap<string, string>,
): SkillRow => {
    const sessions = parseSessionsJson(row.skill_sessions)
        .map(recordKey)
        .filter((v): v is string => v !== null);
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
