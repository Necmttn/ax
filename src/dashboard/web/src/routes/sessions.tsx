import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";
import type { SessionListRow } from "@shared/dashboard-types.ts";

/** Strip the `session:` prefix and any backtick / ⟨⟩ wrappers so we can use
 *  the bare id as a tanstack-router path param. JSONL filenames + the inspect
 *  API both expect the bare id. */
const bareId = (id: string): string => {
    let s = id.startsWith("session:") ? id.slice("session:".length) : id;
    s = s.replace(/^[`⟨]+/, "").replace(/[`⟩]+$/, "");
    return s;
};

const shortId = (id: string): string => bareId(id).slice(0, 12);

const fmtTs = (ts: string | null): string => {
    if (!ts) return "-";
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return ts;
    return d.toISOString().replace("T", " ").slice(0, 16);
};

const fmtDuration = (start: string | null, end: string | null): string => {
    if (!start || !end) return "-";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "-";
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
};

const SOURCE_FILTERS = ["all", "claude", "codex"] as const;
type SourceFilter = typeof SOURCE_FILTERS[number];

function SourceBadge({ source }: { source: string }) {
    const colors: Record<string, { bg: string; fg: string }> = {
        claude: { bg: "#fef3c7", fg: "#92400e" },
        codex: { bg: "#dbeafe", fg: "#1e3a8a" },
        "claude-subagent": { bg: "#fed7aa", fg: "#9a3412" },
    };
    const c = colors[source] ?? { bg: "#e5e7eb", fg: "#475569" };
    return (
        <span style={{ background: c.bg, color: c.fg, padding: "1px 8px", borderRadius: 3, fontSize: 11, fontWeight: 600 }}>
            {source}
        </span>
    );
}

interface RowProps {
    readonly s: SessionListRow;
    readonly indent?: boolean;
    readonly expandedToggle?: { expanded: boolean; childCount: number; onToggle: () => void };
}

function Row({ s, indent, expandedToggle }: RowProps) {
    const sid = bareId(s.id);
    const pretty = s.project ? prettifyProjectSlug(s.project) : null;
    const project = (pretty && pretty !== "(no repo)") ? pretty : (s.cwd ? (s.cwd.split("/").pop() ?? "-") : "-");

    // Warm the inspect-data query on hover/focus - intent-based prefetch
    // avoids stampeding the API when the page has 200 rows.
    const queryClient = useQueryClient();
    const onIntent = () => {
        if (!s.has_raw_file) return;
        void queryClient.prefetchQuery({
            queryKey: ["session-inspect", sid],
            queryFn: () => api.sessionInspect(sid),
            staleTime: 5 * 60_000,
        });
    };

    return (
        <tr style={indent ? { background: "#fafafa" } : undefined} onMouseEnter={onIntent} onFocus={onIntent}>
            <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, paddingLeft: indent ? 32 : 8 }}>
                {expandedToggle ? (
                    <button
                        onClick={expandedToggle.onToggle}
                        style={{
                            border: "none", background: "transparent", cursor: "pointer",
                            padding: "0 6px 0 0", fontFamily: "inherit", fontSize: 12, color: "#64748b",
                        }}
                        title={`${expandedToggle.expanded ? "Collapse" : "Expand"} ${expandedToggle.childCount} subagent${expandedToggle.childCount === 1 ? "" : "s"}`}
                    >
                        {expandedToggle.expanded ? "▼" : "▶"} {expandedToggle.childCount}
                    </button>
                ) : indent ? (
                    <span style={{ color: "#cbd5e1", marginRight: 6 }}>↳</span>
                ) : (
                    <span style={{ display: "inline-block", width: 32 }} />
                )}
                <code title={s.id} style={{ marginLeft: 4 }}>{shortId(s.id)}</code>
            </td>
            <td><SourceBadge source={s.source} /></td>
            <td>{project}</td>
            <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#64748b" }}>{fmtTs(s.started_at)}</td>
            <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#64748b", textAlign: "right" }}>{fmtDuration(s.started_at, s.ended_at)}</td>
            <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#cbd5e1" }}>{s.turn_count > 0 ? s.turn_count.toLocaleString() : "-"}</td>
            <td style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Link to="/sessions/$sessionId" params={{ sessionId: sid }} preload="intent" style={{ color: "var(--muted, #64748b)" }}>overview</Link>
                {s.has_raw_file ? (
                    <Link to="/sessions/$sessionId/inspect" params={{ sessionId: sid }} preload="intent" style={{ color: "var(--blue, #3b82f6)", fontWeight: 600 }}>
                        inspect →
                    </Link>
                ) : (
                    <span style={{ color: "#cbd5e1", fontSize: 11 }} title="No raw transcript stored - cannot inspect">no transcript</span>
                )}
            </td>
        </tr>
    );
}

interface Grouped {
    readonly topLevel: ReadonlyArray<SessionListRow>;
    readonly childrenByParent: Map<string, SessionListRow[]>;
}

function groupByParent(rows: ReadonlyArray<SessionListRow>): Grouped {
    const present = new Set(rows.map((r) => r.id));
    const topLevel: SessionListRow[] = [];
    const childrenByParent = new Map<string, SessionListRow[]>();
    for (const r of rows) {
        // Treat a subagent whose parent is OUT of the current page as
        // top-level so it's still visible. Within the page, nest under parent.
        if (r.parent_session && present.has(r.parent_session)) {
            const list = childrenByParent.get(r.parent_session) ?? [];
            list.push(r);
            childrenByParent.set(r.parent_session, list);
        } else {
            topLevel.push(r);
        }
    }
    // Sort children by started_at ASC so subagents read top→bottom in spawn order.
    for (const list of childrenByParent.values()) {
        list.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
    }
    return { topLevel, childrenByParent };
}

export function SessionsRoute() {
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

    const query = useQuery({
        queryKey: ["sessions", sourceFilter] as const,
        queryFn: () => api.sessions(sourceFilter === "all" ? { limit: 200 } : { limit: 200, source: sourceFilter }),
    });

    const allRows = query.data?.sessions ?? [];
    const filteredRows = useMemo(() => {
        if (!search) return allRows;
        const needle = search.toLowerCase();
        return allRows.filter((s) => {
            const hay = `${s.id} ${s.project ?? ""} ${s.cwd ?? ""} ${s.model ?? ""}`.toLowerCase();
            return hay.includes(needle);
        });
    }, [allRows, search]);

    const grouped = useMemo(() => groupByParent(filteredRows), [filteredRows]);

    const toggleExpanded = (id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <section className="panel">
            <header>
                <h2>Sessions</h2>
                <span className="meta">
                    {query.data ? `${filteredRows.length} of ${allRows.length} · ${grouped.childrenByParent.size} with subagents` : "-"}
                </span>
            </header>
            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            <div style={{ display: "flex", gap: 12, padding: "8px 0", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 4 }}>
                    {SOURCE_FILTERS.map((f) => (
                        <button
                            key={f}
                            onClick={() => setSourceFilter(f)}
                            style={{
                                padding: "4px 12px", fontSize: 11, fontWeight: 600,
                                border: "1px solid #e2e8f0",
                                background: sourceFilter === f ? "#0f172a" : "#fff",
                                color: sourceFilter === f ? "#fff" : "#475569",
                                borderRadius: 4, cursor: "pointer",
                            }}
                        >
                            {f}
                        </button>
                    ))}
                </div>
                <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="filter by id / project / cwd / model"
                    style={{ flex: 1, maxWidth: 360, padding: "4px 8px", fontSize: 12, border: "1px solid #e2e8f0", borderRadius: 4 }}
                />
                {grouped.childrenByParent.size > 0 ? (
                    <button
                        onClick={() => setExpanded((prev) =>
                            prev.size === grouped.childrenByParent.size ? new Set() : new Set(grouped.childrenByParent.keys()),
                        )}
                        style={{
                            padding: "4px 10px", fontSize: 11, border: "1px solid #e2e8f0",
                            background: "#fff", color: "#475569", borderRadius: 4, cursor: "pointer",
                        }}
                    >
                        {expanded.size === grouped.childrenByParent.size ? "collapse all" : "expand all"}
                    </button>
                ) : null}
            </div>
            {query.isLoading && !query.data ? <div className="loading">Loading…</div> : null}
            {query.data ? (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                        <tr style={{ background: "#f8fafc", fontSize: 11, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>id</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>source</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>project</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>started</th>
                            <th style={{ textAlign: "right", padding: "6px 8px" }}>duration</th>
                            <th style={{ textAlign: "right", padding: "6px 8px" }}>turns</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {grouped.topLevel.map((parent) => {
                            const kids = grouped.childrenByParent.get(parent.id) ?? [];
                            const isExpanded = expanded.has(parent.id);
                            return (
                                <>
                                    <Row
                                        key={parent.id}
                                        s={parent}
                                        {...(kids.length > 0
                                            ? { expandedToggle: { expanded: isExpanded, childCount: kids.length, onToggle: () => toggleExpanded(parent.id) } }
                                            : {})}
                                    />
                                    {isExpanded
                                        ? kids.map((child) => <Row key={child.id} s={child} indent />)
                                        : null}
                                </>
                            );
                        })}
                    </tbody>
                </table>
            ) : null}
        </section>
    );
}
