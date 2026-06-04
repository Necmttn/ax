import { useEffect, useRef, useState } from "react";
import { Effect, FileSystem } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { flushSync } from "@opentui/react";
import type { SurrealClientShape } from "@ax/lib/db";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { SKILL_DETAIL_SQL } from "../queries.ts";

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
 * changes; without this we'd kick off a SKILL_DETAIL_SQL + readFile per row.
 * 150ms is short enough to feel instant when the user actually stops, long
 * enough to coalesce continuous keypress streams.
 */
const DETAIL_DEBOUNCE_MS = 150;

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
    client: SurrealClientShape,
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
                client.query<unknown[]>(SKILL_DETAIL_SQL, { name }),
            )
                .then(async (result) => {
                    if (cancelled) return;
                    const payload = Array.isArray(result)
                        ? ([...result].reverse().find((r) => r != null) as
                              | SkillDetailRecord
                              | undefined)
                        : (result as SkillDetailRecord | undefined);

                    // Body lives on disk (dir_path/SKILL.md), not in DB - multi-file
                    // skills + cache staleness make the file canonical.
                    let withBody = payload ?? null;
                    const dirPath = withBody?.skill?.dir_path;
                    if (typeof dirPath === "string" && dirPath.length > 0) {
                        const raw = await readSkillBody(posixPath.join(dirPath, "SKILL.md"));
                        if (raw !== null) {
                            const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
                            const body = (m?.[1] ?? raw).trim();
                            withBody = {
                                ...withBody!,
                                skill: { ...withBody!.skill!, body },
                            };
                        }
                        // Skill file unreadable - leave body undefined.
                    }
                    if (cancelled) return;
                    if (withBody) cacheRef.current.set(name, withBody);
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
    }, [client, name, refreshTick]);

    return { data, loading, error };
}
