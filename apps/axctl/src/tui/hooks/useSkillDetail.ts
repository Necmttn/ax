import { useEffect, useRef, useState } from "react";
import { Effect, FileSystem } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { flushSync } from "@opentui/react";
import { daysAgoExpr } from "@ax/lib/duckdb/clause";
import type { CacheReadService } from "@ax/lib/duckdb/seam";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";

/**
 * Read a skill's SKILL.md body, recovering ANY filesystem failure to `null`
 * (the original try/catch left `body` undefined when the file was unreadable).
 * The TUI keeps no ambient Effect runtime in the React tree (see tui/index.tsx),
 * so the read runs as a self-contained Effect over `BunFileSystem.layer`.
 */
const readSkillBody = (filePath: string): Promise<string | null> =>
    Effect.runPromise(
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* fs.readFileString(filePath);
        }).pipe(orAbsent<string | null>(null), Effect.provide(BunFileSystem.layer)),
    );

/**
 * Debounce window before firing the detail query. Holding j/k spams selection
 * changes; without this we'd kick off a detail query + readFile per row.
 * 150ms is short enough to feel instant when the user actually stops, long
 * enough to coalesce continuous keypress streams.
 */
const DETAIL_DEBOUNCE_MS = 150;

// Local copy, kept separate from `queries/skill-detail.ts`'s
// `fetchSkillDetail` (see that file's module doc: it composes its own
// lookups and exports no shared SQL-text constants for the TUI to import).
// The four queries below run independently in parallel (all filtered by
// skill name, no dependency between them) and are reassembled client-side
// into the SkillDetailRecord shape.

const SKILL_ROW_SQL = `
    SELECT name, scope, description, dir_path, bytes
    FROM skill
    WHERE name = ?
    LIMIT 1
`;

const SKILL_INVOCATION_COUNTS_SQL = `
    SELECT
        count(*) AS total,
        SUM(CASE WHEN iv.ts > ${daysAgoExpr} THEN 1 ELSE 0 END) AS d7,
        SUM(CASE WHEN iv.ts > ${daysAgoExpr} THEN 1 ELSE 0 END) AS d30,
        MAX(iv.ts) AS last
    FROM invoked iv
    JOIN skill sk ON sk.id = iv.out_id
    WHERE sk.name = ?
`;

// `session` is denormalized directly onto the `invoked` edge row, so this
// project lookup is a plain join, not a multi-hop traversal.
const SKILL_RECENT_SQL = `
    SELECT iv.ts AS ts, s.project AS project
    FROM invoked iv
    JOIN skill sk ON sk.id = iv.out_id
    LEFT JOIN session s ON s.id = iv.session
    WHERE sk.name = ?
    ORDER BY iv.ts DESC
    LIMIT 10
`;

const SKILL_DAILY_SQL = `
    SELECT iv.ts AS ts
    FROM invoked iv
    JOIN skill sk ON sk.id = iv.out_id
    WHERE sk.name = ? AND iv.ts > ${daysAgoExpr}
    ORDER BY iv.ts ASC
`;

const toIso = (value: unknown): string | null => {
    if (value == null) return null;
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString();
    try {
        return new Date(value as string).toISOString();
    } catch {
        return null;
    }
};

export interface SkillDetailRecord {
    readonly skill: {
        readonly name: string;
        readonly scope: string;
        readonly description?: string | null;
        readonly dir_path?: string | null;
        /** Body excerpt read from disk (dir_path/SKILL.md) at fetch time, not stored in DB. */
        readonly body?: string | null;
        readonly bytes?: number | null;
    } | null;
    readonly invocations: {
        readonly total: number;
        readonly d7: number;
        readonly d30: number;
        readonly last: string | null;
    };
    readonly recent: ReadonlyArray<{
        readonly ts: string;
        readonly project: string | null;
    }>;
    readonly daily: ReadonlyArray<{ readonly ts: string }>;
}

export interface SkillDetailState {
    readonly data: SkillDetailRecord | null;
    readonly loading: boolean;
    readonly error: string | null;
}

/**
 * Fetch a single skill's detail payload (header + per-day invocations +
 * recent invocations + body for preview). Re-runs whenever `name` changes.
 */
export function useSkillDetail(
    read: CacheReadService,
    name: string | null,
    refreshTick = 0,
): SkillDetailState {
    const [data, setData] = useState<SkillDetailRecord | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Memoise the last successful payload per skill name. Bouncing j/k off
    // and back to the same row should reuse instead of refetching.
    const cacheRef = useRef<Map<string, SkillDetailRecord>>(new Map());

    useEffect(() => {
        if (!name) {
            setData(null);
            setLoading(false);
            setError(null);
            return;
        }

        // refreshTick > 0 means the live-invocation hook fired - cache is
        // stale. On selection changes we keep the cache.
        const cached = refreshTick === 0 ? cacheRef.current.get(name) ?? null : null;
        if (cached) {
            setData(cached);
            setLoading(false);
            setError(null);
            return;
        }

        let cancelled = false;
        setLoading(true);

        const timer = setTimeout(() => {
            if (cancelled) return;
            Effect.runPromise(
                Effect.all(
                    [
                        read.raw(SKILL_ROW_SQL, [name]),
                        read.raw(SKILL_INVOCATION_COUNTS_SQL, [7, 30, name]),
                        read.raw(SKILL_RECENT_SQL, [name]),
                        read.raw(SKILL_DAILY_SQL, [name, 30]),
                    ],
                    { concurrency: 4 },
                ),
            )
                .then(async ([skillResult, countsResult, recentResult, dailyResult]) => {
                    if (cancelled) return;
                    const skillRow = skillResult.rows[0] as Record<string, unknown> | undefined;
                    const countsRow = countsResult.rows[0] as Record<string, unknown> | undefined;

                    const payload: SkillDetailRecord = {
                        skill: skillRow
                            ? {
                                  name: String(skillRow.name ?? name),
                                  scope: String(skillRow.scope ?? ""),
                                  description: (skillRow.description as string | null) ?? null,
                                  dir_path: (skillRow.dir_path as string | null) ?? null,
                                  bytes: skillRow.bytes == null ? null : Number(skillRow.bytes),
                              }
                            : null,
                        invocations: {
                            total: Number(countsRow?.total ?? 0),
                            d7: Number(countsRow?.d7 ?? 0),
                            d30: Number(countsRow?.d30 ?? 0),
                            last: toIso(countsRow?.last),
                        },
                        recent: recentResult.rows.map((row) => ({
                            ts: toIso((row as Record<string, unknown>).ts) ?? "",
                            project: ((row as Record<string, unknown>).project as string | null) ?? null,
                        })),
                        daily: dailyResult.rows.map((row) => ({
                            ts: toIso((row as Record<string, unknown>).ts) ?? "",
                        })),
                    };

                    // Body lives on disk (dir_path/SKILL.md), not in DB - multi-file
                    // skills + cache staleness make the file canonical.
                    let withBody = payload;
                    const dirPath = withBody.skill?.dir_path;
                    if (typeof dirPath === "string" && dirPath.length > 0) {
                        const raw = await readSkillBody(posixPath.join(dirPath, "SKILL.md"));
                        if (raw !== null) {
                            const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                            const body = (m?.[1] ?? raw).trim();
                            withBody = {
                                ...withBody,
                                skill: { ...withBody.skill!, body },
                            };
                        }
                        // Skill file unreadable - leave body undefined.
                    }
                    if (cancelled) return;
                    cacheRef.current.set(name, withBody);
                    flushSync(() => {
                        setData(withBody);
                        setError(null);
                        setLoading(false);
                    });
                })
                .catch((err: unknown) => {
                    if (cancelled) return;
                    flushSync(() => {
                        setError(err instanceof Error ? err.message : String(err));
                        setLoading(false);
                    });
                });
        }, DETAIL_DEBOUNCE_MS);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [read, name, refreshTick]);

    return { data, loading, error };
}
