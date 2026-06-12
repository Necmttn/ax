import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api.ts";
import { shouldPollFallback } from "../poll-fallback.ts";
import { useIngestStream, type StageFileFailures, type StageStatus } from "../use-ingest-stream.ts";

/**
 * App-wide ingest splash over Durable Streams - the Live tab's stream plumbing
 * reborn as an overlay (spec: improve-first dashboard, PR2).
 *
 * Landing while a run is active (persisted stream URL) re-attaches and shows
 * the overlay immediately; the masthead "Ingest" button starts a fresh run.
 * On the compiled binary the sidecar can't host live ingest (`live_ingest:
 * false` on /api/version) - the button hides and no overlay ever shows; the
 * SSE-driven query invalidation in use-ingest-events still refreshes views
 * during a CLI-driven backfill.
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

/** How long the finished state lingers before the overlay auto-dismisses. */
const FINISH_LINGER_MS = 1500;

export function IngestSplash() {
    const queryClient = useQueryClient();
    // Rehydrate the active stream URL on mount so landing mid-run shows the splash.
    const [streamUrl, setStreamUrl] = useState<string | null>(() => readPersistedStreamUrl());
    const [busy, setBusy] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const [triggerError, setTriggerError] = useState<string | null>(null);
    /** HTTP status of the last failed POST /api/ingest (503 = sidecar gone). */
    const [triggerStatus, setTriggerStatus] = useState<number | undefined>(undefined);

    const run = useIngestStream(streamUrl);

    // Capability probe: live_ingest=false (compiled binary) hides the trigger.
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

    // Invalidate the dashboard query keys on each stage delta so views climb live.
    const stageSig = run.order.map((s) => `${s}:${run.stages[s]}`).join("|");
    useEffect(() => {
        if (!streamUrl) return;
        void queryClient.invalidateQueries({ queryKey: ["skills"] });
        void queryClient.invalidateQueries({ queryKey: ["tool-failures"] });
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["workflow"] });
        void queryClient.invalidateQueries({ queryKey: ["next-actions"] });
    }, [stageSig, run.finished, streamUrl, queryClient]);

    // Once finished: clear the persisted URL, linger briefly, then dismiss.
    const finishedRef = useRef(false);
    useEffect(() => {
        if (run.finished && !finishedRef.current) {
            finishedRef.current = true;
            persistStreamUrl(null);
            const t = setTimeout(() => {
                setStreamUrl(null);
                setDismissed(false);
            }, FINISH_LINGER_MS);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [run.finished]);

    // Stale persisted URL from a previous serve session: clear and drop to idle.
    useEffect(() => {
        if (streamUrl && run.error && run.order.length === 0 && !run.finished) {
            persistStreamUrl(null);
            setStreamUrl(null);
            setTriggerError(
                "Previous run's live stream was unreachable (serve restarted). Cleared - hit Ingest to start fresh.",
            );
        }
    }, [streamUrl, run.error, run.order.length, run.finished]);

    const start = async () => {
        setBusy(true);
        setTriggerError(null);
        setDismissed(false);
        finishedRef.current = false;
        try {
            const res = await api.ingest();
            persistStreamUrl(res.stream);
            setStreamUrl(res.stream);
        } catch (err) {
            if (err instanceof ApiError && err.status === 503) {
                // Sidecar unavailable (compiled binary) - hide the trigger.
                setTriggerStatus(err.status);
            } else {
                setTriggerError(err instanceof Error ? err.message : String(err));
            }
        } finally {
            setBusy(false);
        }
    };

    const live = streamUrl !== null;
    const overlayVisible = live && !dismissed;

    return (
        <>
            {polling ? null : (
                <button
                    type="button"
                    className="masthead-ingest-btn"
                    onClick={() => (live ? setDismissed(false) : void start())}
                    disabled={busy}
                    title={live ? "Show ingest progress" : "Run an ingest pass"}
                >
                    {busy ? "Starting…" : live && !run.finished ? "Ingesting…" : "Ingest"}
                </button>
            )}
            {triggerError ? <span className="meta masthead-ingest-error">{triggerError}</span> : null}
            {overlayVisible ? (
                <div className="ingest-splash" role="status" aria-live="polite">
                    <div className="ingest-splash-panel panel">
                        <header>
                            <h2>
                                {run.finished
                                    ? run.runStatus === "completed" ? "Ingest complete" : "Ingest failed"
                                    : "Ingesting…"}
                            </h2>
                            <span className="meta">{run.label ?? "live ingest run"}</span>
                        </header>
                        {run.error ? (
                            <div className="error">
                                Stream error: {run.error}. The run may have finished or the serve
                                session restarted.
                            </div>
                        ) : null}
                        <CountTiles />
                        <StageChecklist run={run} />
                        <div className="actions" style={{ marginTop: 12 }}>
                            <button type="button" className="badge review" onClick={() => setDismissed(true)}>
                                Continue in background
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </>
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
 *  detail list (path + error). Skipped files retry on the next ingest run -
 *  they are warnings, not stage errors. */
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

/** Count tiles on the same React Query keys the stage-delta effect invalidates,
 *  so the numbers visibly climb while the run fills the graph. */
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
