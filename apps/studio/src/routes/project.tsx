import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ForesightLink } from "../foresight-link.ts";
import { api } from "../api.ts";
import { fmtCount, fmtLastUsed, fmtTs } from "@ax/lib/shared/formatters";
import { prettifyProjectSlug } from "@ax/lib/shared/project-slug";
import { shortSessionId } from "@ax/lib/shared/session-id";

const fmtDuration = (start: string | null, end: string | null): string => {
    if (!start || !end) return "-";
    const s = Date.parse(start);
    const e = Date.parse(end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return "-";
    const ms = e - s;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm === 0 ? `${h}h` : `${h}h${mm}m`;
};

export function ProjectRoute() {
    const { slug } = useParams({ from: "/projects/$slug" });
    const decoded = decodeURIComponent(slug);
    const query = useQuery({
        queryKey: ["project", decoded],
        queryFn: () => api.project(decoded),
    });
    const data = query.data ?? null;
    const loading = query.isLoading;
    const error = query.error ? String(query.error) : null;

    return (
        <section className="panel">
            <header>
                <h2>{data ? prettifyProjectSlug(data.project) : "Project"}</h2>
                <span className="meta">
                    {data ? (
                        <>
                            <code>{data.project}</code>
                            {" · "}
                            {data.session_count} sessions · last activity{" "}
                            {fmtLastUsed(data.last_session_at)}
                        </>
                    ) : null}
                </span>
            </header>

            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}

            {data ? (
                <>
                    <div className="session-overview">
                        <div className="overview-row">
                            <span className="overview-key">Sessions</span>
                            <span>
                                <strong>{fmtCount(data.session_count)}</strong>
                                {data.sources.map((s) => (
                                    <span
                                        key={s.source}
                                        className="chip"
                                        style={{ marginLeft: 6 }}
                                    >
                                        {s.source} · {fmtCount(s.count)}
                                    </span>
                                ))}
                            </span>
                        </div>
                        <div className="overview-row">
                            <span className="overview-key">First seen</span>
                            <span>
                                {data.first_session_at ? fmtTs(data.first_session_at) : "-"}
                            </span>
                        </div>
                        <div className="overview-row">
                            <span className="overview-key">Last seen</span>
                            <span>
                                {data.last_session_at ? fmtTs(data.last_session_at) : "-"}
                            </span>
                        </div>
                    </div>

                    <h3 className="workflow-h3">Top skills</h3>
                    {data.top_skills.length === 0 ? (
                        <p className="workflow-help">No invocations recorded for this project.</p>
                    ) : (
                        <table className="skills">
                            <thead>
                                <tr>
                                    <th>Skill</th>
                                    <th className="num">Invocations</th>
                                    <th>Last used</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.top_skills.map((s) => (
                                    <tr key={s.skill}>
                                        <td>
                                            <ForesightLink
                                                to="/skills"
                                                search={{ q: s.skill }}
                                                style={{ textDecoration: "none" }}
                                            >
                                                <code>{s.skill}</code>
                                            </ForesightLink>
                                        </td>
                                        <td className="num">
                                            <strong>{fmtCount(s.count)}</strong>
                                        </td>
                                        <td>{fmtLastUsed(s.last_used)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    <h3 className="workflow-h3">Tool failures</h3>
                    {data.failures.length === 0 ? (
                        <p className="workflow-help">No failed tool calls.</p>
                    ) : (
                        <table className="skills">
                            <thead>
                                <tr>
                                    <th>Label</th>
                                    <th className="num">Failures</th>
                                    <th className="num">Sessions</th>
                                    <th>Last seen</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.failures.map((f) => (
                                    <tr key={f.label}>
                                        <td>
                                            <ForesightLink
                                                to="/tools"
                                                search={{ q: f.label }}
                                                style={{ textDecoration: "none" }}
                                            >
                                                <code>{f.label}</code>
                                            </ForesightLink>
                                        </td>
                                        <td className="num">
                                            <strong>{fmtCount(f.failure_count)}</strong>
                                        </td>
                                        <td className="num">{fmtCount(f.distinct_sessions)}</td>
                                        <td>{fmtLastUsed(f.last_seen)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    <h3 className="workflow-h3">Top episodes</h3>
                    {data.top_episodes.length === 0 ? (
                        <p className="workflow-help">No episodes spawned subagents in this project.</p>
                    ) : (
                        <table className="skills">
                            <thead>
                                <tr>
                                    <th>Started</th>
                                    <th className="num">Subagents</th>
                                    <th className="num">Distinct names</th>
                                    <th>Parent</th>
                                    <th>Episode</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.top_episodes.map((ep) => (
                                    <tr key={ep.parent_session_id}>
                                        <td>
                                            <code>
                                                {ep.started_at ? fmtTs(ep.started_at) : "-"}
                                            </code>
                                        </td>
                                        <td className="num">
                                            <strong>{ep.child_count}</strong>
                                        </td>
                                        <td className="num">{ep.distinct_nicknames}</td>
                                        <td>
                                            <Link
                                                to="/sessions/$sessionId"
                                                params={{ sessionId: ep.parent_session_id }}
                                            >
                                                <code>{shortSessionId(ep.parent_session_id)}…</code>
                                            </Link>
                                        </td>
                                        <td>
                                            <Link
                                                to="/episodes/$parentId"
                                                params={{ parentId: ep.parent_session_id }}
                                                className="badge keep"
                                                style={{ textDecoration: "none" }}
                                            >
                                                timeline →
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    <h3 className="workflow-h3">Recent sessions</h3>
                    {data.recent_sessions.length === 0 ? (
                        <p className="workflow-help">No sessions yet.</p>
                    ) : (
                        <table className="skills">
                            <thead>
                                <tr>
                                    <th>Started</th>
                                    <th>Source</th>
                                    <th>Model</th>
                                    <th className="num">Duration</th>
                                    <th>Session</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.recent_sessions.map((s) => (
                                    <tr key={s.session_id}>
                                        <td>
                                            <code>
                                                {s.started_at ? fmtTs(s.started_at) : "-"}
                                            </code>
                                        </td>
                                        <td>
                                            <span className="chip">{s.source ?? "?"}</span>
                                        </td>
                                        <td>
                                            <small>{s.model ?? "-"}</small>
                                        </td>
                                        <td className="num">
                                            {fmtDuration(s.started_at, s.ended_at)}
                                        </td>
                                        <td>
                                            <Link
                                                to="/sessions/$sessionId"
                                                params={{ sessionId: s.session_id }}
                                            >
                                                <code>{shortSessionId(s.session_id)}…</code>
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </>
            ) : null}
        </section>
    );
}
