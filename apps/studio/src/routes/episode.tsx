import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    EpisodeNode,
    EpisodeTimelinePayload,
} from "@shared/dashboard-types.ts";
import { fmtCount, fmtTs } from "@shared/formatters.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";
import { PHASE_LABEL, type Phase } from "@shared/phases.ts";
import { shortSessionId } from "@shared/session-id.ts";

const PHASE_TONE: Record<EpisodeNode["phase"], string> = {
    plan: "var(--gold)",
    execute: "var(--blue)",
    review: "var(--green)",
    merge: "var(--ink)",
    other: "var(--muted)",
    mixed: "var(--red)",
};

const fmtDuration = (ms: number | null): string => {
    if (ms === null || ms < 0) return "-";
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm === 0 ? `${h}h` : `${h}h${mm}m`;
};

export function EpisodeRoute() {
    const { parentId } = useParams({ from: "/episodes/$parentId" });
    const decoded = decodeURIComponent(parentId);
    const query = useQuery({
        queryKey: ["episode", decoded],
        queryFn: () => api.episodeTimeline(decoded),
    });
    const data = query.data ?? null;
    const loading = query.isLoading;
    const error = query.error ? String(query.error) : null;

    return (
        <section className="panel">
            <header>
                <h2>Episode</h2>
                <span className="meta">
                    {data ? (
                        <>
                            <code>{shortSessionId(data.parent_session_id)}…</code>
                            {" · "}
                            {prettifyProjectSlug(data.project)}
                            {" · "}
                            {data.node_count} sessions · shape{" "}
                            <strong>{data.shape || "-"}</strong> · ran{" "}
                            {fmtDuration(data.duration_ms)}
                        </>
                    ) : null}
                </span>
            </header>
            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}
            {data ? <EpisodeTimelineView data={data} /> : null}
        </section>
    );
}

function EpisodeTimelineView({ data }: { data: EpisodeTimelinePayload }) {
    const parent = data.nodes.find((n) => n.role === "parent") ?? null;
    const children = data.nodes.filter((n) => n.role === "child");

    // Phase distribution among children, useful at a glance.
    const phaseCounts = useMemo(() => {
        const counts: Partial<Record<EpisodeNode["phase"], number>> = {};
        for (const n of children) {
            counts[n.phase] = (counts[n.phase] ?? 0) + 1;
        }
        return counts;
    }, [children]);

    // Layout the timeline as proportions of episode duration. Each child
    // bar's left + width are pct of the total span.
    const totalSpan =
        data.duration_ms !== null && data.duration_ms > 0 ? data.duration_ms : 1;
    const episodeStart = data.started_at ? Date.parse(data.started_at) : 0;

    const pctLeft = (start: string | null): number => {
        if (!start || !episodeStart) return 0;
        const t = Date.parse(start);
        if (Number.isNaN(t)) return 0;
        return Math.max(0, Math.min(100, ((t - episodeStart) / totalSpan) * 100));
    };
    const pctWidth = (start: string | null, end: string | null): number => {
        if (!start || !end) return 1;
        const s = Date.parse(start);
        const e = Date.parse(end);
        if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 1;
        return Math.max(0.5, ((e - s) / totalSpan) * 100);
    };

    return (
        <div>
            {parent ? (
                <div className="session-overview">
                    <div className="overview-row">
                        <span className="overview-key">Parent</span>
                        <span>
                            <Link
                                to="/sessions/$sessionId"
                                params={{ sessionId: parent.session_id }}
                            >
                                <code>{shortSessionId(parent.session_id)}…</code>
                            </Link>{" "}
                            <span className="chip">{parent.source ?? "?"}</span>
                        </span>
                    </div>
                    <div className="overview-row">
                        <span className="overview-key">Project</span>
                        <span>{prettifyProjectSlug(parent.project)}</span>
                    </div>
                    <div className="overview-row">
                        <span className="overview-key">Span</span>
                        <span>
                            {fmtTs(parent.started_at)} →{" "}
                            {parent.ended_at ? fmtTs(parent.ended_at) : "-"} (
                            {fmtDuration(parent.duration_ms)})
                        </span>
                    </div>
                    <div className="overview-row">
                        <span className="overview-key">Subagents</span>
                        <span>
                            <strong>{children.length}</strong>{" "}
                            {Object.entries(phaseCounts)
                                .filter(([, count]) => (count ?? 0) > 0)
                                .map(([phase, count]) => (
                                    <span
                                        key={phase}
                                        className="chip"
                                        style={{
                                            background:
                                                PHASE_TONE[phase as EpisodeNode["phase"]] ??
                                                "var(--muted)",
                                            color: "var(--page)",
                                            marginLeft: 4,
                                        }}
                                    >
                                        {(phase as string).slice(0, 1).toUpperCase()} ·{" "}
                                        {count}
                                    </span>
                                ))}
                        </span>
                    </div>
                </div>
            ) : null}

            <h3 className="workflow-h3">Timeline</h3>
            <p className="workflow-help">
                Each row is a session in the episode. Bar position = relative time
                inside the episode; colour = dominant phase.
            </p>
            <div className="episode-timeline">
                {data.nodes.map((node) => {
                    const left = pctLeft(node.started_at);
                    const width = pctWidth(node.started_at, node.ended_at);
                    return (
                        <div key={node.session_id} className="timeline-row">
                            <div className="timeline-meta">
                                <Link
                                    to="/sessions/$sessionId"
                                    params={{ sessionId: node.session_id }}
                                    className="timeline-link"
                                >
                                    <code>{shortSessionId(node.session_id)}…</code>
                                </Link>
                                <span
                                    className="phase-badge"
                                    style={{
                                        backgroundColor:
                                            PHASE_TONE[node.phase] ?? "var(--muted)",
                                    }}
                                    title={PHASE_LABEL[node.phase as Phase] ?? node.phase}
                                >
                                    {node.phase[0]?.toUpperCase()}
                                </span>
                                <small>
                                    {node.role === "parent" ? "parent" : node.source}
                                </small>
                            </div>
                            <div className="timeline-track">
                                <div
                                    className={`timeline-bar timeline-${node.phase}`}
                                    style={{
                                        left: `${left}%`,
                                        width: `${width}%`,
                                    }}
                                    title={`${node.phase} · ${fmtDuration(node.duration_ms)} · ${fmtCount(node.invocation_count)} invocations`}
                                />
                            </div>
                            <div className="timeline-tail">
                                <small>
                                    {fmtDuration(node.duration_ms)} ·{" "}
                                    {fmtCount(node.invocation_count)} invs
                                    {node.top_skills.length > 0 ? (
                                        <>
                                            {" · "}
                                            {node.top_skills
                                                .slice(0, 2)
                                                .map((s) => s.skill)
                                                .join(", ")}
                                        </>
                                    ) : null}
                                </small>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
