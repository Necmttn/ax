import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";
import { useIngestStream, type StageStatus } from "../use-ingest-stream.ts";

/**
 * Live ingest view over Durable Streams.
 *
 * "Run ingest" → POST /api/ingest → subscribe to the returned sidecar stream →
 * stages tick green as they finish + dashboard count tiles climb live. A
 * refresh mid-run rehydrates from the persisted stream URL (the hook replays
 * the stream from the start, so finished stages show as done).
 */

const STREAM_URL_KEY = "ax-ingest-live-stream-url";

function readPersistedStreamUrl(): string | null {
    if (typeof window === "undefined") return null;
    try {
        const v = window.localStorage.getItem(STREAM_URL_KEY);
        return v && /^https?:\/\//.test(v) ? v : null;
    } catch {
        return null;
    }
}

function persistStreamUrl(url: string | null): void {
    if (typeof window === "undefined") return;
    try {
        if (url) window.localStorage.setItem(STREAM_URL_KEY, url);
        else window.localStorage.removeItem(STREAM_URL_KEY);
    } catch {
        /* ignore */
    }
}

const STAGE_GLYPH: Record<StageStatus, string> = {
    running: "…",
    ok: "✓",
    error: "✗",
};

export function IngestLiveRoute() {
    const queryClient = useQueryClient();
    // Rehydrate the active stream URL on mount so a refresh mid-run re-attaches.
    const [streamUrl, setStreamUrl] = useState<string | null>(() => readPersistedStreamUrl());
    const [busy, setBusy] = useState(false);
    const [triggerError, setTriggerError] = useState<string | null>(null);

    const run = useIngestStream(streamUrl);

    // While a run is live, invalidate the count-tile query keys on each new
    // delta so the numbers refetch and visibly climb. These are the same keys
    // `use-ingest-events.ts` drives (skills / tool-failures / sessions /
    // workflow). On `run_finished` we do a final sweep.
    const stageSig = run.order.map((s) => `${s}:${run.stages[s]}`).join("|");
    useEffect(() => {
        if (!streamUrl) return;
        void queryClient.invalidateQueries({ queryKey: ["skills"] });
        void queryClient.invalidateQueries({ queryKey: ["tool-failures"] });
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["workflow"] });
    }, [stageSig, run.finished, streamUrl, queryClient]);

    // Clear the persisted URL once the run finishes so a later refresh doesn't
    // re-attach to a completed run. (A refresh DURING a run still rehydrates,
    // because the URL is persisted while live.)
    const finishedRef = useRef(false);
    useEffect(() => {
        if (run.finished && !finishedRef.current) {
            finishedRef.current = true;
            persistStreamUrl(null);
        }
    }, [run.finished]);

    // A stale persisted stream URL (a sidecar port from a previous serve session)
    // can't connect and never delivers events. Clear it so we stop hammering a
    // dead port, drop back to idle, and tell the user to re-run.
    useEffect(() => {
        if (streamUrl && run.error && run.order.length === 0 && !run.finished) {
            persistStreamUrl(null);
            setStreamUrl(null);
            setTriggerError(
                "Previous run's live stream was unreachable (serve restarted). Cleared - click Run ingest to start fresh.",
            );
        }
    }, [streamUrl, run.error, run.order.length, run.finished]);

    const start = async () => {
        setBusy(true);
        setTriggerError(null);
        finishedRef.current = false;
        try {
            const res = await api.ingest();
            persistStreamUrl(res.stream);
            setStreamUrl(res.stream);
        } catch (err) {
            setTriggerError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const idle = !streamUrl;
    const live = streamUrl && !run.finished;

    return (
        <section className="panel">
            <header>
                <h2>Live Ingest</h2>
                <span className="meta">
                    {run.label ? `${run.label} · ` : ""}
                    {idle
                        ? "idle"
                        : run.finished
                        ? run.runStatus === "completed"
                            ? "completed"
                            : "failed"
                        : "running…"}
                </span>
            </header>

            <div className="actions" style={{ margin: "8px 0 16px" }}>
                <button
                    type="button"
                    className="badge keep"
                    onClick={start}
                    disabled={busy || Boolean(live)}
                >
                    {busy ? "Starting…" : live ? "Running…" : "Run ingest"}
                </button>
                {run.finished ? (
                    <button type="button" onClick={start} disabled={busy}>
                        Run again
                    </button>
                ) : null}
            </div>

            {triggerError ? <div className="error">Error: {triggerError}</div> : null}
            {run.error ? (
                <div className="error">
                    Stream error: {run.error}. The run may have finished or the serve
                    session restarted - try Run ingest again.
                </div>
            ) : null}

            <CountTiles />

            {idle ? (
                <div className="empty">
                    No active run. Hit <strong>Run ingest</strong> to stream a live
                    ingest pass - stages tick green and the counts above climb as data
                    lands.
                </div>
            ) : (
                <StageChecklist run={run} />
            )}
        </section>
    );
}

function StageChecklist({ run }: { run: ReturnType<typeof useIngestStream> }) {
    if (run.order.length === 0) {
        return <div className="loading">Connecting to stream…</div>;
    }
    return (
        <ul className="ingest-stages">
            {run.order.map((stage) => {
                const status = run.stages[stage] ?? "running";
                return (
                    <li key={stage} className={`ingest-stage ${status}`}>
                        <span className="ingest-stage-glyph">{STAGE_GLYPH[status]}</span>
                        <span className="ingest-stage-name">{stage}</span>
                        <span className="ingest-stage-status">{status}</span>
                    </li>
                );
            })}
        </ul>
    );
}

/** Count tiles reusing the same React Query keys the live SSE hook invalidates,
 *  so they refetch and climb as the run progresses. */
function CountTiles() {
    const skillsQuery = useQuery({
        queryKey: ["skills"],
        queryFn: () => api.skills(),
    });
    const sessionsQuery = useQuery({
        queryKey: ["sessions", "all"],
        queryFn: () => api.sessions({ limit: 1 }),
    });
    const failuresQuery = useQuery({
        queryKey: ["tool-failures"],
        queryFn: () => api.toolFailures(),
    });

    const skills = skillsQuery.data?.skills.length ?? null;
    const sessions = sessionsQuery.data?.total_count ?? null;
    const failures = failuresQuery.data?.failures.length ?? null;

    return (
        <div className="wrapped-metrics" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <div className="wrapped-metric">
                <span>Skills</span>
                <strong>{skills ?? "-"}</strong>
            </div>
            <div className="wrapped-metric">
                <span>Sessions</span>
                <strong>{sessions ?? "-"}</strong>
            </div>
            <div className="wrapped-metric">
                <span>Tool failures</span>
                <strong>{failures ?? "-"}</strong>
            </div>
        </div>
    );
}
