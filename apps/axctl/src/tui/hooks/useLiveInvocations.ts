import { useEffect, useState } from "react";
import { Effect } from "effect";
import { flushSync } from "@opentui/react";
import { Table, type LiveSubscription } from "surrealdb";
import type { SurrealClientShape } from "@ax/lib/db";

/**
 * Live state pushed by SurrealDB live queries on the `invoked` relation table.
 *
 * `tick` is bumped on every CREATE event; consumers (`useSkills`,
 * `useSkillDetail`) re-run their queries when the tick advances, so the
 * dashboard reflects new invocations within ~1s of arrival.
 *
 * `lastEvent` carries a low-fidelity hint suitable for status-bar use:
 * the skill's record id (e.g. `skill:foo`) and the event timestamp.
 */
export interface LiveInvocationsState {
    readonly tick: number;
    readonly lastEvent: { readonly skill: string; readonly ts: string } | null;
}

const POLL_FALLBACK_MS = 5000;
const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECTS = 3;

interface InvokedRow {
    readonly out?: unknown;
    readonly ts?: unknown;
}

const extractSkill = (value: InvokedRow | null | undefined): string => {
    if (!value) return "";
    const out = (value as { out?: unknown }).out;
    if (out == null) return "";
    // RecordId, string, or any value with toString
    return String(out);
};

const extractTs = (value: InvokedRow | null | undefined): string => {
    const ts = value?.ts;
    if (ts == null) return new Date().toISOString();
    if (typeof ts === "string") return ts;
    if (ts instanceof Date) return ts.toISOString();
    try {
        return new Date(ts as string).toISOString();
    } catch {
        return new Date().toISOString();
    }
};

/**
 * Subscribe to new `invoked` relation rows via a managed SurrealDB live query.
 *
 * Failure modes handled:
 *   1. Server doesn't support live queries → fall back to 5s polling of a
 *      `count()` heartbeat, matching the pre-live behaviour.
 *   2. WebSocket drops → the v3 SDK's ManagedLiveSubscription auto-restarts
 *      itself; we additionally retry up to 3 times on outright `live()`
 *      failure with a 1s delay before falling back to polling.
 *
 * Live queries on relation tables (here `invoked`) work with the bare table
 * name; the FROM-edge form (e.g. `<-invoked`) is for traversal queries and
 * cannot be used as a live source.
 */
export function useLiveInvocations(
    client: SurrealClientShape,
    enabled = true,
): LiveInvocationsState {
    const [tick, setTick] = useState(0);
    const [lastEvent, setLastEvent] = useState<
        LiveInvocationsState["lastEvent"]
    >(null);

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;
        let activeSub: LiveSubscription | null = null;
        let unsubscribe: (() => void) | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let attempts = 0;

        const startPolling = (): void => {
            if (cancelled || pollTimer !== null) return;
            let lastSeen = 0;
            const fetchCount = (): Promise<number> =>
                Effect.runPromise(
                    client.query<[Array<{ c: number }>]>(
                        "SELECT count() AS c FROM invoked GROUP ALL;",
                    ),
                )
                    .then((r) => r?.[0]?.[0]?.c ?? lastSeen)
                    .catch(() => lastSeen);

            // Capture baseline without bumping tick.
            void fetchCount().then((c) => {
                if (!cancelled) lastSeen = c;
            });

            pollTimer = setInterval(() => {
                void fetchCount().then((c) => {
                    if (cancelled) return;
                    if (c !== lastSeen) {
                        lastSeen = c;
                        flushSync(() => setTick((t) => t + 1));
                    }
                });
            }, POLL_FALLBACK_MS);
        };

        const scheduleReconnect = (): void => {
            if (cancelled) return;
            if (attempts >= MAX_RECONNECTS) {
                startPolling();
                return;
            }
            attempts += 1;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                void connect();
            }, RECONNECT_DELAY_MS);
        };

        const connect = async (): Promise<void> => {
            if (cancelled) return;
            try {
                // `live<T>(table)` returns a ManagedLivePromise that resolves
                // to the active subscription. The ManagedLiveSubscription
                // restarts itself when the WS reconnects, so we only need
                // explicit retry handling for the initial dispatch.
                const sub: LiveSubscription = await client.raw.live<InvokedRow>(
                    new Table("invoked"),
                );
                if (cancelled) {
                    void sub.kill().catch(() => undefined);
                    return;
                }
                activeSub = sub;
                attempts = 0; // success resets retry budget

                unsubscribe = sub.subscribe((message) => {
                    if (cancelled) return;
                    if (message.action !== "CREATE") return;
                    const row = message.value as InvokedRow;
                    const skill = extractSkill(row);
                    const ts = extractTs(row);
                    flushSync(() => {
                        setTick((t) => t + 1);
                        setLastEvent({ skill, ts });
                    });
                });
            } catch (err) {
                // Distinguish "server doesn't support live" from transient
                // disconnects. The SDK throws LiveSubscriptionError with
                // unsupported=true in the former case; treat anything else as
                // transient and retry briefly before falling back to polling.
                const unsupported =
                    typeof err === "object" &&
                    err !== null &&
                    (err as { unsupported?: unknown }).unsupported === true;
                if (unsupported) {
                    startPolling();
                    return;
                }
                scheduleReconnect();
            }
        };

        void connect();

        return () => {
            cancelled = true;
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            if (pollTimer !== null) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            if (unsubscribe) {
                try {
                    unsubscribe();
                } catch {
                    /* best effort */
                }
                unsubscribe = null;
            }
            if (activeSub) {
                void activeSub.kill().catch(() => undefined);
                activeSub = null;
            }
        };
    }, [client, enabled]);

    return { tick, lastEvent };
}
