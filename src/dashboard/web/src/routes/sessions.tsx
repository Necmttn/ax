import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../api.ts";
import { prettifyProjectSlug } from "@shared/project-slug.ts";
import type { SessionListResponse, SessionListRow } from "@shared/dashboard-types.ts";

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
    readonly expandedToggle?: { expanded: boolean; childCount: number; loading?: boolean; onToggle: () => void };
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

    const rowStyle = indent ? { background: "#fafafa" } : undefined;

    return (
        <tr style={rowStyle} onMouseEnter={onIntent} onFocus={onIntent}>
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
                        {expandedToggle.loading ? " …" : ""}
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

/** Number of direct children for a root row. Uses the server-supplied count
 *  (which is always present on `/api/sessions` rows). */
const childCountOf = (row: SessionListRow): number => row.direct_children_count ?? 0;

const PAGE_SIZE = 200;

export function SessionsRoute() {
    const queryClient = useQueryClient();
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

    // Cache by filter set only - appended pages share the same key so
    // setQueryData accumulates across loadMore() calls (mirrors recall.tsx).
    const baseKey = ["sessions", sourceFilter] as const;
    const query = useQuery({
        queryKey: baseKey,
        queryFn: () =>
            api.sessions(
                sourceFilter === "all"
                    ? { offset: 0, limit: PAGE_SIZE }
                    : { offset: 0, limit: PAGE_SIZE, source: sourceFilter },
            ),
    });

    const allRoots = query.data?.sessions ?? [];
    const totalCount = query.data?.total_count ?? 0;
    const [appendLoading, setAppendLoading] = useState(false);
    // Synchronous re-entrancy guard - mirrors the inspector's loadingRef
    // pattern so a rapid IntersectionObserver burst can't double-fetch the
    // same page before React commits `appendLoading`.
    const loadingRef = useRef(false);

    const loadMore = async (count: number = PAGE_SIZE) => {
        const data = query.data;
        if (!data) return;
        if (data.sessions.length >= data.total_count) return;
        if (loadingRef.current) return;
        loadingRef.current = true;
        setAppendLoading(true);
        try {
            const page = await api.sessions(
                sourceFilter === "all"
                    ? { offset: data.sessions.length, limit: count }
                    : { offset: data.sessions.length, limit: count, source: sourceFilter },
            );
            queryClient.setQueryData<SessionListResponse>(baseKey, (prev) => {
                if (!prev) return prev;
                // why: `window` describes the slice the server returned, not
                // the cumulative loaded range. Leave it pinned to the first
                // page so its documented semantic ("server-returned slice")
                // holds (mirrors recall.tsx fix).
                return {
                    ...prev,
                    sessions: [...prev.sessions, ...page.sessions],
                    total_count: page.total_count,
                };
            });
        } finally {
            loadingRef.current = false;
            setAppendLoading(false);
        }
    };

    // Sentinel-driven lazy page load. Same rootMargin as recall.tsx so the
    // next page kicks in before the user reaches the bottom.
    const sentinelRef = useRef<HTMLTableRowElement | null>(null);
    useEffect(() => {
        if (!query.data) return;
        if (query.data.sessions.length >= query.data.total_count) return;
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
    }, [query.data?.sessions.length, query.data?.total_count]);
    const filteredRoots = useMemo(() => {
        if (!search) return allRoots;
        const needle = search.toLowerCase();
        return allRoots.filter((s) => {
            const hay = `${s.id} ${s.project ?? ""} ${s.cwd ?? ""} ${s.model ?? ""}`.toLowerCase();
            return hay.includes(needle);
        });
    }, [allRoots, search]);

    // Count of roots that have at least one direct child. Server tells us
    // this per-row via direct_children_count - no extra fetch needed.
    const rootsWithChildren = useMemo(
        () => filteredRoots.reduce((n, r) => n + (childCountOf(r) > 0 ? 1 : 0), 0),
        [filteredRoots],
    );

    // Lazy children fetches, one per currently-expanded root. TanStack
    // Query dedups + caches across re-renders so a row that's collapsed and
    // re-expanded doesn't refetch within the staleTime window.
    const expandedIds = useMemo(() => Array.from(expanded), [expanded]);
    const childQueries = useQueries({
        queries: expandedIds.map((id) => ({
            queryKey: ["session-children", id] as const,
            queryFn: () => api.sessionChildren(bareId(id)),
            staleTime: 5 * 60_000,
        })),
    });
    const childrenByParent = useMemo(() => {
        const m = new Map<string, { loading: boolean; rows: ReadonlyArray<SessionListRow> }>();
        expandedIds.forEach((id, i) => {
            const q = childQueries[i];
            m.set(id, {
                loading: !!q?.isLoading,
                rows: q?.data?.children ?? [],
            });
        });
        return m;
    }, [expandedIds, childQueries]);

    const toggleExpanded = (id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const allExpandableIds = useMemo(
        () => filteredRoots.filter((r) => childCountOf(r) > 0).map((r) => r.id),
        [filteredRoots],
    );

    return (
        <section className="panel">
            <header>
                <h2>Sessions</h2>
                <span className="meta">
                    {query.data
                        ? `${allRoots.length.toLocaleString()} of ${totalCount.toLocaleString()} roots · ${rootsWithChildren} with subagents${search ? ` · ${filteredRoots.length} match search` : ""}`
                        : "-"}
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
                {allExpandableIds.length > 0 ? (
                    <button
                        onClick={() => setExpanded((prev) =>
                            prev.size === allExpandableIds.length ? new Set() : new Set(allExpandableIds),
                        )}
                        style={{
                            padding: "4px 10px", fontSize: 11, border: "1px solid #e2e8f0",
                            background: "#fff", color: "#475569", borderRadius: 4, cursor: "pointer",
                        }}
                    >
                        {expanded.size === allExpandableIds.length ? "collapse all" : "expand all"}
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
                        {filteredRoots.map((parent) => {
                            const childCount = childCountOf(parent);
                            const isExpanded = expanded.has(parent.id);
                            const kidState = childrenByParent.get(parent.id);
                            return (
                                <Fragment key={parent.id}>
                                    <Row
                                        s={parent}
                                        {...(childCount > 0
                                            ? {
                                                expandedToggle: {
                                                    expanded: isExpanded,
                                                    childCount,
                                                    loading: !!kidState?.loading,
                                                    onToggle: () => toggleExpanded(parent.id),
                                                },
                                            }
                                            : {})}
                                    />
                                    {isExpanded
                                        ? (kidState?.rows ?? []).map((child) => <Row key={child.id} s={child} indent />)
                                        : null}
                                </Fragment>
                            );
                        })}
                        {allRoots.length < totalCount ? (
                            <tr ref={sentinelRef}>
                                <td colSpan={7} style={{
                                    padding: "12px 24px", color: "#64748b", fontSize: 12,
                                    fontFamily: "ui-monospace, monospace",
                                    textAlign: "center", borderTop: "1px dashed #e2e8f0",
                                }}>
                                    {appendLoading
                                        ? `loading next ${PAGE_SIZE} of ${totalCount.toLocaleString()}…`
                                        : `loaded ${allRoots.length.toLocaleString()} of ${totalCount.toLocaleString()} ·`}
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
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            ) : null}
        </section>
    );
}
