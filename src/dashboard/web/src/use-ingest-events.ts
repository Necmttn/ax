import { useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

interface IngestEvent {
    readonly source?: string;
    readonly stage?: string;
    readonly level?: string;
    readonly ts?: string;
}

/**
 * Map an ingest event to the React Query keys it should invalidate.
 * Conservative: anything that touches sessions/turns/tool_calls/invoked also
 * invalidates the broader rollups (workflow + project + episode + sessionDetail)
 * because those views aggregate across all of them.
 */
function keysFor(stage: string | undefined): ReadonlyArray<ReadonlyArray<unknown>> {
    if (!stage) return [["workflow"], ["skills"]];
    const s = stage.toLowerCase();
    if (s.startsWith("skill")) {
        return [["skills"], ["decisions"]];
    }
    if (s.startsWith("tool") || s.includes("failure")) {
        return [["tool-failures"], ["workflow"]];
    }
    if (
        s.startsWith("session") ||
        s.startsWith("transcript") ||
        s.startsWith("claude") ||
        s.startsWith("codex") ||
        s.startsWith("invoke") ||
        s.startsWith("spawn") ||
        s.startsWith("signal")
    ) {
        return [["workflow"], ["episode"], ["project"], ["sessionDetail"], ["skills"]];
    }
    // Unknown stage → invalidate everything.
    return [["workflow"], ["skills"], ["tool-failures"], ["episode"], ["project"]];
}

function flushInvalidate(
    queryClient: QueryClient,
    keys: Set<string>,
): void {
    for (const k of keys) {
        const parsed = JSON.parse(k) as ReadonlyArray<unknown>;
        // queryKey can be a prefix; React Query matches by deep-equal prefix.
        void queryClient.invalidateQueries({ queryKey: parsed as unknown[] });
    }
}

export interface LiveStatus {
    readonly connected: boolean;
    readonly lastEventAt: string | null;
}

export function useIngestEvents(): LiveStatus {
    const queryClient = useQueryClient();
    const [status, setStatus] = useState<LiveStatus>({
        connected: false,
        lastEventAt: null,
    });
    const pendingRef = useRef<Set<string>>(new Set());
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const source = new EventSource("/api/events");
        const scheduleFlush = () => {
            if (timerRef.current) return;
            timerRef.current = setTimeout(() => {
                timerRef.current = null;
                const batch = pendingRef.current;
                pendingRef.current = new Set();
                if (batch.size > 0) flushInvalidate(queryClient, batch);
            }, 500);
        };

        const onIngest = (msg: MessageEvent) => {
            let data: IngestEvent | null = null;
            try {
                data = JSON.parse(msg.data) as IngestEvent;
            } catch {
                return;
            }
            for (const key of keysFor(data?.stage)) {
                pendingRef.current.add(JSON.stringify(key));
            }
            setStatus({
                connected: true,
                lastEventAt: data?.ts ?? new Date().toISOString(),
            });
            scheduleFlush();
        };

        const onReady = () => {
            setStatus((s) => ({ ...s, connected: true }));
        };
        const onError = () => {
            setStatus((s) => ({ ...s, connected: false }));
        };

        source.addEventListener("ingest_event", onIngest);
        source.addEventListener("ready", onReady);
        source.addEventListener("error", onError);

        return () => {
            source.removeEventListener("ingest_event", onIngest);
            source.removeEventListener("ready", onReady);
            source.removeEventListener("error", onError);
            source.close();
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [queryClient]);

    return status;
}
