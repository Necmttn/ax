import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { api } from "../api.ts";
import { fmtTs } from "@shared/formatters.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";
import { shortSessionId } from "@shared/session-id.ts";

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

const PAGE_SIZE = 50;

export function RecallRoute() {
    const navigate = useNavigate({ from: "/recall" });
    const search = useSearch({ from: "/recall" });
    const queryClient = useQueryClient();
    const [q, setQ] = useState<string>(search.q ?? "");
    const [project, setProject] = useState<string>(search.project ?? "");
    const [skill, setSkill] = useState<string>(search.skill ?? "");
    const [since, setSince] = useState<string>(search.since ?? "");

    const activeQ = (search.q ?? "").trim();
    const activeProject = (search.project ?? "").trim() || null;
    const activeSkill = (search.skill ?? "").trim() || null;
    const activeSince = (search.since ?? "").trim() || null;

    // Cache by filter set only - the appended pages share the same key so
    // setQueryData accumulates across loadMore() calls.
    const baseKey = ["recall", activeQ, activeProject, activeSkill, activeSince] as const;
    const query = useQuery({
        queryKey: baseKey,
        queryFn: () =>
            api.recall({
                q: activeQ,
                project: activeProject,
                skill: activeSkill,
                since: activeSince,
                offset: 0,
                limit: PAGE_SIZE,
            }),
        enabled: activeQ.length > 0,
    });
    const data = query.data ?? null;
    const loading = query.isFetching;
    const error = query.error ? String(query.error) : null;
    const [appendLoading, setAppendLoading] = useState(false);

    /** Fetch the next page and append to the cached payload. Mirrors the
     *  inspector's loadMore() so the IO/cache contract stays consistent. */
    const loadMore = async (count: number = PAGE_SIZE) => {
        if (!data) return;
        if (data.hits.length >= data.total_count) return;
        if (appendLoading) return;
        setAppendLoading(true);
        try {
            const page = await api.recall({
                q: activeQ,
                project: activeProject,
                skill: activeSkill,
                since: activeSince,
                offset: data.hits.length,
                limit: count,
            });
            queryClient.setQueryData<typeof data>(baseKey, (prev) => {
                if (!prev) return prev;
                // why: `window` describes the slice the server returned, not the
                // cumulative loaded range. Leave it pinned to the first page so
                // its documented semantic ("server-returned slice") holds.
                return {
                    ...prev,
                    hits: [...prev.hits, ...page.hits],
                    truncated: prev.hits.length + page.hits.length < prev.total_count,
                };
            });
        } finally {
            setAppendLoading(false);
        }
    };

    // Sentinel-driven lazy page load.
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!data) return;
        if (data.hits.length >= data.total_count) return;
        const el = sentinelRef.current;
        if (!el) return;
        const obs = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) void loadMore();
            }
        }, { rootMargin: "400px 0px" });
        obs.observe(el);
        return () => obs.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data?.hits.length, data?.total_count]);

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
                        {data.total_count === 0
                            ? "No matches."
                            : `${data.hits.length.toLocaleString()} of ${data.total_count.toLocaleString()} match${data.total_count === 1 ? "" : "es"}`}
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
                                        <code>{shortSessionId(hit.session_id)}…</code>
                                    </Link>
                                    <code>{hit.ts ? fmtTs(hit.ts) : "-"}</code>
                                </div>
                                <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
                                    {highlight(hit.snippet, activeQ)}
                                </div>
                            </li>
                        ))}
                    </ul>
                    {data.hits.length < data.total_count ? (
                        <div
                            ref={sentinelRef}
                            style={{
                                padding: "12px 24px", color: "var(--muted)", fontSize: 12,
                                fontFamily: "ui-monospace, monospace",
                                textAlign: "center", borderTop: "1px dashed #e2e8f0",
                            }}
                        >
                            {appendLoading
                                ? `loading next ${PAGE_SIZE} of ${data.total_count.toLocaleString()}…`
                                : `loaded ${data.hits.length.toLocaleString()} of ${data.total_count.toLocaleString()} ·`}
                            {!appendLoading ? (
                                <>
                                    {" "}
                                    <button
                                        onClick={() => void loadMore(PAGE_SIZE)}
                                        style={{
                                            padding: "2px 10px", marginLeft: 6, fontSize: 11,
                                            border: "1px solid #e2e8f0", background: "#fff",
                                            color: "#475569", borderRadius: 4, cursor: "pointer",
                                        }}
                                    >load {PAGE_SIZE} more</button>
                                </>
                            ) : null}
                        </div>
                    ) : null}
                </>
            ) : null}
        </section>
    );
}
