import { useEffect, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import type { SurrealClientShape } from "../../lib/db.ts";
import { SKILL_DETAIL_SQL } from "../queries.ts";

export interface SkillDetailRecord {
    readonly skill: {
        readonly name: string;
        readonly scope: string;
        readonly description?: string | null;
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

    useEffect(() => {
        if (!name) {
            setData(null);
            setLoading(false);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        const debug = (msg: string) => {
            try {
                require("node:fs").appendFileSync(
                    "/tmp/agentctl-tui-debug.log",
                    `${new Date().toISOString()} useSkillDetail name=${JSON.stringify(name)} ${msg}\n`,
                );
            } catch {
                /* swallow */
            }
        };
        debug(`fetch start`);
        Effect.runPromise(
            client.query<unknown[]>(SKILL_DETAIL_SQL, { name }),
        )
            .then((result) => {
                if (cancelled) return;
                debug(`raw result type=${typeof result} isArr=${Array.isArray(result)} len=${Array.isArray(result) ? result.length : "n/a"} sample=${JSON.stringify(result).slice(0,200)}`);
                // SurrealDB returns one entry per statement; LET yields null,
                // RETURN yields the payload. Pick last non-null.
                const payload = Array.isArray(result)
                    ? ([...result].reverse().find((r) => r != null) as
                          | SkillDetailRecord
                          | undefined)
                    : (result as SkillDetailRecord | undefined);
                // OpenTUI's reconciler waits for an event-loop flush; an
                // async setState from a Promise.then callback is otherwise
                // not committed to the renderer until the next keypress.
                flushSync(() => {
                    setData(payload ?? null);
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
        return () => {
            cancelled = true;
        };
    }, [client, name, refreshTick]);

    return { data, loading, error };
}
