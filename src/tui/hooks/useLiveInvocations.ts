import { useEffect, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import type { SurrealClientShape } from "../../lib/db.ts";

/**
 * Polling fallback for live invocation updates.
 *
 * Tries to be a thin wrapper over SurrealDB live queries (`LIVE SELECT * FROM
 * invoked`), but the v2 driver's live API is not exposed through our wrapped
 * `SurrealClient` service yet. Until we extend the wrapper, we just poll a
 * cheap heartbeat query every 5s and bump a tick counter; consumers
 * (`useSkills`, `useSkillDetail`) re-run their queries when the tick advances.
 *
 * If a new invocation arrives, the next tick will refetch counters and the
 * list re-sorts in place. End-to-end latency is bounded by `intervalMs`.
 */
export function useLiveInvocations(
    client: SurrealClientShape,
    intervalMs = 5000,
): number {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        let cancelled = false;
        let lastSeen = 0;

        const fetchCount = (): Promise<number> =>
            Effect.runPromise(
                client.query<[Array<{ c: number }>]>(
                    "SELECT count() AS c FROM invoked GROUP ALL;",
                ),
            )
                .then((result) => result?.[0]?.[0]?.c ?? 0)
                .catch(() => lastSeen);

        // Capture baseline; do not bump tick on first read.
        void fetchCount().then((c) => {
            if (!cancelled) lastSeen = c;
        });

        const handle = setInterval(() => {
            void fetchCount().then((c) => {
                if (cancelled) return;
                if (c !== lastSeen) {
                    lastSeen = c;
                    // Force commit to the OpenTUI renderer; without this the
                    // tick would not redraw until the next keypress.
                    flushSync(() => setTick((t) => t + 1));
                }
            });
        }, intervalMs);

        return () => {
            cancelled = true;
            clearInterval(handle);
        };
    }, [client, intervalMs]);

    return tick;
}
