import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../api.ts";
import { fmtTs } from "@shared/formatters.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";

const shortId = (id: string): string =>
    id.replace(/^session:⟨/, "").replace(/⟩$/, "").slice(0, 12) + "…";

function highlight(snippet: string, q: string): React.ReactNode {
    if (!q) return snippet;
    const idx = snippet.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return snippet;
    return (
        <>
            {snippet.slice(0, idx)}
            <mark>{snippet.slice(idx, idx + q.length)}</mark>
            {snippet.slice(idx + q.length)}
        </>
    );
}

export function RecallRoute() {
    const navigate = useNavigate({ from: "/recall" });
    const search = useSearch({ from: "/recall" });
    const [q, setQ] = useState<string>(search.q ?? "");
    const [project, setProject] = useState<string>(search.project ?? "");
    const [skill, setSkill] = useState<string>(search.skill ?? "");
    const [since, setSince] = useState<string>(search.since ?? "");

    const activeQ = (search.q ?? "").trim();
    const activeProject = (search.project ?? "").trim() || null;
    const activeSkill = (search.skill ?? "").trim() || null;
    const activeSince = (search.since ?? "").trim() || null;

    const query = useQuery({
        queryKey: ["recall", activeQ, activeProject, activeSkill, activeSince],
        queryFn: () =>
            api.recall({
                q: activeQ,
                project: activeProject,
                skill: activeSkill,
                since: activeSince,
            }),
        enabled: activeQ.length > 0,
    });
    const data = query.data ?? null;
    const loading = query.isFetching;
    const error = query.error ? String(query.error) : null;

    const submit = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        void navigate({
            search: {
                q: q.trim() || undefined,
                project: project.trim() || undefined,
                skill: skill.trim() || undefined,
                since: since.trim() || undefined,
            },
        });
    };

    return (
        <section className="panel">
            <header>
                <h2>Recall</h2>
                <span className="meta">
                    Cross-session text search over user/assistant turn excerpts.
                </span>
            </header>

            <form
                onSubmit={submit}
                className="recall-form"
                style={{ display: "grid", gap: 8, marginBottom: 16 }}
            >
                <input
                    autoFocus
                    placeholder="search text (e.g. helm chart, effect refactor)"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    style={{ padding: "8px 10px", fontSize: 13 }}
                />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input
                        placeholder="project (raw slug, optional)"
                        value={project}
                        onChange={(e) => setProject(e.target.value)}
                        style={{ flex: "1 1 200px", padding: "6px 8px", fontSize: 12 }}
                    />
                    <input
                        placeholder="skill name (optional)"
                        value={skill}
                        onChange={(e) => setSkill(e.target.value)}
                        style={{ flex: "1 1 160px", padding: "6px 8px", fontSize: 12 }}
                    />
                    <input
                        placeholder="since (ISO ts, optional)"
                        value={since}
                        onChange={(e) => setSince(e.target.value)}
                        style={{ flex: "1 1 160px", padding: "6px 8px", fontSize: 12 }}
                    />
                    <button type="submit" className="badge keep">
                        Search
                    </button>
                </div>
            </form>

            {error ? <div className="error">Error: {error}</div> : null}
            {!activeQ ? (
                <p className="workflow-help">Enter a query to start searching.</p>
            ) : loading && !data ? (
                <div className="loading">Searching…</div>
            ) : data ? (
                <>
                    <p className="workflow-help">
                        {data.hits.length === 0
                            ? "No matches."
                            : `${data.hits.length} match${data.hits.length === 1 ? "" : "es"}${data.truncated ? " (capped at 50)" : ""}`}
                    </p>
                    <ul className="recall-hits" style={{ listStyle: "none", padding: 0 }}>
                        {data.hits.map((hit) => (
                            <li
                                key={hit.turn_id}
                                style={{
                                    padding: "10px 12px",
                                    borderLeft: "3px solid var(--blue)",
                                    background: "var(--panel)",
                                    marginBottom: 6,
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        gap: 12,
                                        alignItems: "center",
                                        fontSize: 11,
                                        color: "var(--muted)",
                                        marginBottom: 6,
                                    }}
                                >
                                    <span className="chip">{hit.source ?? "?"}</span>
                                    <span className="chip">{hit.role ?? "?"}</span>
                                    {hit.project ? (
                                        <Link
                                            to="/projects/$slug"
                                            params={{ slug: hit.project }}
                                            style={{ textDecoration: "none" }}
                                        >
                                            {prettifyProjectSlug(hit.project)}
                                        </Link>
                                    ) : null}
                                    <Link
                                        to="/sessions/$sessionId"
                                        params={{ sessionId: hit.session_id }}
                                    >
                                        <code>{shortId(hit.session_id)}</code>
                                    </Link>
                                    <code>{hit.ts ? fmtTs(hit.ts) : "-"}</code>
                                </div>
                                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                                    {highlight(hit.snippet, activeQ)}
                                </div>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
        </section>
    );
}
