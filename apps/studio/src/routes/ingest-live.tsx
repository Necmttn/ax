import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.ts";
import { POLL_INTERVAL_MS, shouldPollFallback } from "../poll-fallback.ts";
import { useIngestStream, type StageFileFailures, type StageStatus } from "../use-ingest-stream.ts";

/**
 * Live ingest view over Durable Streams.
 *
 * "Run ingest" → POST /api/ingest → subscribe to the returned sidecar stream →
 * stages tick green as they finish + dashboard count tiles climb live. A
 * refresh mid-run rehydrates from the persisted stream URL (the hook replays
 * the stream from the start, so finished stages show as done).
 *
 * Polling fallback: on the compiled binary the Durable Streams sidecar can't
 * load, so the stream path is dead. The daemon advertises that via
 * `live_ingest: false` on GET /api/version (older daemons: we catch the 503
 * from POST /api/ingest instead) and this view drops to refetching the count
 * tiles every 5s so a CLI-driven backfill is still visible. See
 * poll-fallback.ts; the streaming path stays preferred and untouched.
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
    /** HTTP status of the last failed POST /api/ingest (503 = sidecar gone). */
    const [triggerStatus, setTriggerStatus] = useState<number | undefined>(undefined);

    const run = useIngestStream(streamUrl);

    // Capability probe: the daemon says up front whether the Durable Streams
    // sidecar is hosting live ingest (false on the compiled binary). Older
    // daemons omit the flag - then the 503 catch in start() is the trigger.
    const versionQuery = useQuery({
        queryKey: ["daemon-version"],
        queryFn: () => api.version(),
        staleTime: 60_000,
        retry: false,
    });
    const polling = shouldPollFallback({
        liveIngest: versionQuery.data?.live_ingest,
        triggerStatus,
    });

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
            if (err instanceof ApiError && err.status === 503) {
                // Sidecar unavailable (compiled binary) - switch to the
                // polling fallback instead of dead-ending on the error.
                setTriggerStatus(err.status);
            } else {
                setTriggerError(err instanceof Error ? err.message : String(err));
            }
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
                        ? polling ? "polling" : "idle"
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
                    disabled={busy || Boolean(live) || polling}
                    title={polling ? "Live ingest needs ax running from source" : undefined}
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
            {polling ? (
                <div className="empty" role="status">
                    Live stream unavailable - polling every {POLL_INTERVAL_MS / 1000}s.
                </div>
            ) : null}

            <CountTiles pollMs={polling ? POLL_INTERVAL_MS : false} />

            {idle ? (
                polling ? (
                    <div className="empty">
                        Live streaming needs ax running from source (the compiled binary
                        can't host the Durable Streams sidecar). Run{" "}
                        <strong>ax ingest</strong> in a terminal - the counts above
                        refresh automatically while it fills.
                    </div>
                ) : (
                    <div className="empty">
                        No active run. Hit <strong>Run ingest</strong> to stream a live
                        ingest pass - stages tick green and the counts above climb as data
                        lands.
                    </div>
                )
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
                const p = run.progress[stage];
                const pct = p && p.total > 0 ? Math.min(100, Math.round((p.current / p.total) * 100)) : null;
                const skipped = run.fileFailures[stage];
                return (
                    <li key={stage} className={`ingest-stage ${status}`}>
                        <div className="ingest-stage-row">
                            <span className="ingest-stage-glyph">{STAGE_GLYPH[status]}</span>
                            <span className="ingest-stage-name">{stage}</span>
                            {status === "running" && p && pct !== null ? (
                                <span className="ingest-stage-bar" aria-label={`${pct}%`}>
                                    <span className="ingest-stage-bar-fill" style={{ width: `${pct}%` }} />
                                </span>
                            ) : null}
                            <span className="ingest-stage-status">
                                {status === "running" && p && pct !== null
                                    ? `${p.current.toLocaleString()}/${p.total.toLocaleString()} · ${pct}%${
                                        p.ratePerSec > 0 ? ` · ${p.ratePerSec.toFixed(1)}/s` : ""
                                    }${p.etaLeftMs !== null ? ` · ~${formatEtaLeft(p.etaLeftMs)} left` : ""}`
                                    : status}
                            </span>
                        </div>
                        {skipped && skipped.total > 0 ? <SkippedFiles skipped={skipped} /> : null}
                    </li>
                );
            })}
        </ul>
    );
}

/** Collapsed "N files skipped" row under a stage; expands to the failure
 *  detail list (path + error). The detail list is capped upstream (25), so a
 *  larger total gets an "and N more" overflow line. Skipped files retry on
 *  the next ingest run - they are warnings, not stage errors. */
function SkippedFiles({ skipped }: { skipped: StageFileFailures }) {
    const overflow = skipped.total - skipped.failures.length;
    return (
        <details className="ingest-stage-skipped">
            <summary>
                {skipped.total.toLocaleString()} file{skipped.total === 1 ? "" : "s"} skipped
                (retry next run)
            </summary>
            <ul className="ingest-stage-skipped-list">
                {skipped.failures.map((f) => (
                    <li key={f.filePath}>
                        <code className="ingest-stage-skipped-path">{f.filePath}</code>
                        <span className="ingest-stage-skipped-error">
                            [{f.tag}] {f.message}
                        </span>
                    </li>
                ))}
                {overflow > 0 ? (
                    <li className="ingest-stage-skipped-overflow">…and {overflow.toLocaleString()} more</li>
                ) : null}
            </ul>
        </details>
    );
}

/** Compact remaining-time label for the live progress bar ("3m30s", "45s"). */
function formatEtaLeft(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
}

/** Count tiles reusing the same React Query keys the live SSE hook invalidates,
 *  so they refetch and climb as the run progresses. `pollMs` is the polling
 *  fallback: when the live stream can't run (compiled binary) the tiles
 *  refetch on an interval instead of waiting for stream-driven invalidation. */
function CountTiles({ pollMs = false }: { pollMs?: number | false }) {
    const skillsQuery = useQuery({
        queryKey: ["skills"],
        queryFn: () => api.skills(),
        refetchInterval: pollMs,
    });
    const sessionsQuery = useQuery({
        queryKey: ["sessions", "all"],
        queryFn: () => api.sessions({ limit: 1 }),
        refetchInterval: pollMs,
    });
    const failuresQuery = useQuery({
        queryKey: ["tool-failures"],
        queryFn: () => api.toolFailures(),
        refetchInterval: pollMs,
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
