import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../api.ts";
import type {
    SessionAgentDelegation,
    SessionDetailPayload,
    SessionLink,
} from "@shared/dashboard-types.ts";
import { fmtCount, fmtLastUsed, fmtTs } from "@shared/formatters.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";
import { PHASE_LABEL, type Phase } from "@shared/phases.ts";

const PHASE_TONE: Record<Phase, string> = {
    plan: "var(--gold)",
    execute: "var(--blue)",
    review: "var(--green)",
    merge: "var(--ink)",
    other: "var(--muted)",
};

function PhaseBadge({ phase }: { phase: Phase }) {
    return (
        <span
            className="phase-badge"
            style={{ backgroundColor: PHASE_TONE[phase] }}
            title={PHASE_LABEL[phase]}
        >
            {phase[0]?.toUpperCase()}
        </span>
    );
}

const shortId = (id: string): string =>
    id.replace(/^session:⟨/, "").replace(/⟩$/, "").slice(0, 12) + "…";

export function SessionRoute() {
    const { sessionId } = useParams({ from: "/sessions/$sessionId" });
    const decoded = decodeURIComponent(sessionId);
    const detailQuery = useQuery({
        queryKey: ["session", decoded],
        queryFn: () => api.sessionDetail(decoded),
    });
    const data = detailQuery.data ?? null;
    const loading = detailQuery.isLoading;
    const error = detailQuery.error ? String(detailQuery.error) : null;
    return (
        <section className="panel">
            <header>
                <h2>Session</h2>
                <span className="meta">
                    <code>{shortId(decoded)}</code>
                </span>
            </header>
            {error ? <div className="error">Error: {error}</div> : null}
            {loading && !data ? <div className="loading">Loading…</div> : null}
            {data ? <SessionDetailView data={data} /> : null}
        </section>
    );
}

function SessionDetailView({ data }: { data: SessionDetailPayload }) {
    const ov = data.overview;
    return (
        <div className="session-detail">
            {!ov ? (
                <div className="empty">Session record not found.</div>
            ) : (
                <div className="session-overview">
                    <div className="overview-row">
                        <span className="overview-key">Project</span>
                        <span>
                            {ov.project ? (
                                <Link
                                    to="/projects/$slug"
                                    params={{ slug: ov.project }}
                                    style={{ textDecoration: "none" }}
                                >
                                    {prettifyProjectSlug(ov.project)}
                                </Link>
                            ) : (
                                prettifyProjectSlug(ov.project)
                            )}
                        </span>
                    </div>
                    <div className="overview-row">
                        <span className="overview-key">Source</span>
                        <span className="chip">{ov.source}</span>
                    </div>
                    {ov.model ? (
                        <div className="overview-row">
                            <span className="overview-key">Model</span>
                            <span>{ov.model}</span>
                        </div>
                    ) : null}
                    <div className="overview-row">
                        <span className="overview-key">Started</span>
                        <span>{ov.started_at ? fmtTs(ov.started_at) : "-"}</span>
                    </div>
                    <div className="overview-row">
                        <span className="overview-key">Ended</span>
                        <span>
                            {ov.ended_at
                                ? `${fmtTs(ov.ended_at)} (${fmtLastUsed(ov.ended_at)})`
                                : "-"}
                        </span>
                    </div>
                    {ov.cwd ? (
                        <div className="overview-row">
                            <span className="overview-key">cwd</span>
                            <code>{ov.cwd}</code>
                        </div>
                    ) : null}
                </div>
            )}

            {data.parent ? (
                <>
                    <h3 className="workflow-h3">Parent session</h3>
                    <ul className="link-list">
                        <SessionLinkLi link={data.parent} />
                    </ul>
                </>
            ) : null}

            {data.children.length > 0 ? (
                <>
                    <h3 className="workflow-h3">
                        Spawned subagents ({data.children.length})
                    </h3>
                    <ul className="link-list scrollable">
                        {data.children.map((c) => (
                            <SessionLinkLi
                                key={`${c.session_id}-${c.ts ?? ""}`}
                                link={c}
                            />
                        ))}
                    </ul>
                </>
            ) : null}

            {data.agent_delegations.length > 0 ? (
                <>
                    <h3 className="workflow-h3">
                        Agent delegations (Claude, inline) ({data.agent_delegations.length})
                    </h3>
                    <p className="workflow-help">
                        Claude's <code>Agent</code> tool runs subagents synchronously
                        - there's no separate session, but the <em>intent</em> of each
                        delegation tells us a lot.
                    </p>
                    <ul className="delegation-list">
                        {data.agent_delegations.map((d) => (
                            <AgentDelegationLi key={d.id} delegation={d} />
                        ))}
                    </ul>
                </>
            ) : null}

            {data.top_skills.length > 0 ? (
                <>
                    <h3 className="workflow-h3">Top skills in this session</h3>
                    <table className="skills">
                        <thead>
                            <tr>
                                <th>Skill</th>
                                <th className="num">Calls</th>
                                <th className="num">Last</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.top_skills.map((s) => (
                                <tr key={s.skill}>
                                    <td>
                                        <Link to="/skills" search={{ q: s.skill }}>
                                            <strong>{s.skill}</strong>
                                        </Link>
                                    </td>
                                    <td className="num">{fmtCount(s.count)}</td>
                                    <td className="num">{fmtLastUsed(s.last_used)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            ) : null}

            {data.tool_calls.length > 0 ? (
                <>
                    <h3 className="workflow-h3">Tool calls</h3>
                    <table className="skills">
                        <thead>
                            <tr>
                                <th>Command</th>
                                <th className="num">Calls</th>
                                <th className="num">Failures</th>
                                <th className="num">Last</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.tool_calls.map((t) => (
                                <tr key={t.label}>
                                    <td>
                                        <Link to="/tools" search={{ q: t.label }}>
                                            <strong>{t.label}</strong>
                                        </Link>
                                    </td>
                                    <td className="num">{fmtCount(t.count)}</td>
                                    <td className="num">
                                        {t.failures > 0 ? (
                                            <span className="text-red">
                                                {fmtCount(t.failures)}
                                            </span>
                                        ) : (
                                            <small>0</small>
                                        )}
                                    </td>
                                    <td className="num">{fmtLastUsed(t.last_used)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            ) : null}
        </div>
    );
}

function SessionLinkLi({ link }: { link: SessionLink }) {
    return (
        <li>
            <Link
                to="/sessions/$sessionId"
                params={{ sessionId: link.session_id }}
                className="session-link"
            >
                <code>{shortId(link.session_id)}</code>
                {link.nickname ? <span className="chip">{link.nickname}</span> : null}
                {link.project ? (
                    <span>{prettifyProjectSlug(link.project)}</span>
                ) : null}
                {link.ts ? <small>{fmtLastUsed(link.ts)}</small> : null}
            </Link>
        </li>
    );
}

function AgentDelegationLi({ delegation }: { delegation: SessionAgentDelegation }) {
    return (
        <li>
            <div className="delegation-head">
                <PhaseBadge phase={delegation.phase} />
                <span className="chip">{delegation.subagent_type ?? "agent"}</span>
                {delegation.description ? (
                    <strong>{delegation.description}</strong>
                ) : (
                    <em>(no description)</em>
                )}
                <small className="delegation-ts">{fmtTs(delegation.ts)}</small>
            </div>
            {delegation.prompt_excerpt ? (
                <pre className="delegation-prompt">{delegation.prompt_excerpt}</pre>
            ) : null}
        </li>
    );
}
