import { useEffect, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import type { CacheReadService } from "@ax/lib/duckdb/seam";

/**
 * Live state pushed by polling `invoked` row counts.
 *
 * `tick` is bumped whenever the count changes; consumers (`useSkills`,
 * `useSkillDetail`) re-run their queries when the tick advances, so the
 * dashboard reflects new invocations within one poll interval.
 *
 * `lastEvent` is `null` under DuckDB: a count-delta poll has no per-row
 * payload to report (unlike the old SurrealDB LIVE QUERY, which streamed the
 * actual CREATE record). `StatusBar` already renders `lastEvent == null`
 * gracefully (it is also `null` on initial mount and every poll tick that
 * finds no change), so the pane is never silently empty - it just loses the
 * "which skill fired" hint in the status line.
 */
export interface LiveInvocationsState {
    readonly tick: number;
    readonly lastEvent: { readonly skill: string; readonly ts: string } | null;
}

/**
 * DuckDB (the v2 cache seam, `packages/lib/src/duckdb/seam.ts`) has no push
 * notification mechanism - no LIVE QUERY, no pub/sub, just a snapshot file the
 * daemon republishes after each ingest. This hook used to open a managed
 * SurrealDB `live()` subscription and only fell back to polling a `count()`
 * heartbeat when the server didn't support live queries at all. Under DuckDB
 * that fallback path is now the ONLY path: it was already implemented,
 * already exercised (the "server doesn't support live" branch), and produces
 * the same `tick`-advances-on-change contract every consumer already expects
 * - so `ax tui` keeps updating on new invocations, just on a 5s cadence
 * instead of near-instant push, rather than rendering a frozen or empty pane.
 */
const POLL_INTERVAL_MS = 5000;

const INVOKED_COUNT_SQL = "SELECT count(*) AS c FROM invoked";

export function useLiveInvocations(
    read: CacheReadService,
    enabled = true,
): LiveInvocationsState {
    const [tick, setTick] = useState(0);
    const [lastEvent] = useState<LiveInvocationsState["lastEvent"]>(null);

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;
        let lastSeen: number | null = null;

        const fetchCount = (): Promise<number> =>
            Effect.runPromise(read.raw(INVOKED_COUNT_SQL))
                .then((result) => {
                    const row = result.rows[0] as Record<string, unknown> | undefined;
                    const c = Number(row?.c ?? 0);
                    return Number.isFinite(c) ? c : (lastSeen ?? 0);
                })
                .catch(() => lastSeen ?? 0);

        // Capture baseline without bumping tick.
        void fetchCount().then((c) => {
            if (!cancelled) lastSeen = c;
        });

        const pollTimer = setInterval(() => {
            void fetchCount().then((c) => {
                if (cancelled) return;
                if (lastSeen !== null && c !== lastSeen) {
                    lastSeen = c;
                    flushSync(() => setTick((t) => t + 1));
                } else {
                    lastSeen = c;
                }
            });
        }, POLL_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearInterval(pollTimer);
        };
    }, [read, enabled]);

    return { tick, lastEvent };
}
