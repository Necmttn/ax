import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { api } from "../api.ts";
import { BurnSpark } from "../components/session-insight/BurnSpark.tsx";
import { InsightPanel } from "../components/session-insight/InsightPanel.tsx";
import { SignalBadge } from "../components/session-insight/SignalBadge.tsx";
import { sessionProjectLabel } from "@ax/lib/shared/project-slug";
import type { SessionListResponse, SessionListRow } from "@ax/lib/shared/dashboard-types";
import { shortSessionId } from "@ax/lib/shared/session-id";

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

export const SOURCE_FILTERS = ["all", "claude", "codex", "pi", "opencode", "cursor"] as const;
type SourceFilter = typeof SOURCE_FILTERS[number];

export const SOURCE_BADGE_COLORS: Record<string, { bg: string; fg: string }> = {
    claude: { bg: "#fef3c7", fg: "#92400e" },
    codex: { bg: "#dbeafe", fg: "#1e3a8a" },
    pi: { bg: "#dcfce7", fg: "#166534" },
    opencode: { bg: "#f3e8ff", fg: "#6b21a8" },
    cursor: { bg: "#cffafe", fg: "#155e75" },
    "claude-subagent": { bg: "#fed7aa", fg: "#9a3412" },
};

function SourceBadge({ source }: { source: string }) {
    const c = SOURCE_BADGE_COLORS[source] ?? { bg: "#e5e7eb", fg: "var(--muted)" };
    return (
        <span style={{ background: c.bg, color: c.fg, padding: "1px 8px", borderRadius: 3, fontSize: 11, fontWeight: 600 }}>
            {source}
        </span>
    );
}

interface RowProps {
    readonly s: SessionListRow;
    readonly indent?: boolean;
    readonly burnP90?: number | null;
    // Expanded-toggle props (root rows with children only)
    readonly childCount?: number;
    readonly childLoading?: boolean;
    readonly expanded?: boolean;
    readonly onToggleExpanded?: (id: string) => void;
    // Insight panel props (root rows only)
    readonly insightOpen?: boolean;
    readonly onToggleInsight?: (id: string) => void;
    // Selection props (all rows)
    readonly isSelected?: boolean;
    readonly onToggleSelect: (id: string) => void;
}

const Row = memo(function Row({
    s,
    indent,
    burnP90,
    childCount,
    childLoading,
    expanded,
    onToggleExpanded,
    insightOpen,
    onToggleInsight,
    isSelected,
    onToggleSelect,
}: RowProps) {
    // The wire seam delivers a bare session id (see src/lib/shared/session-id.ts);
    // any backtick/`session:` prefix reaching us would be a server bug.
    const sid = s.id;
    const project = sessionProjectLabel(s.project, s.cwd);
    const open = insightOpen ?? false;
    const panelId = `session-insight-${sid}`;
    const hasInsight = onToggleInsight != null;
    const hasExpandedToggle = onToggleExpanded != null && childCount != null && childCount > 0;

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

    const rowStyle: CSSProperties | undefined = open
        ? {
            background: "var(--sx-tint-50)",
            boxShadow: "inset 3px 0 0 var(--sx-ink-900)",
            cursor: "pointer",
        }
        : indent
            ? { background: "#fafafa" }
            : hasInsight
                ? { cursor: "pointer" }
                : undefined;

    const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
        if (!hasInsight) return;
        const target = event.target;
        if (target instanceof Element && target.closest("a,button,input")) return;
        onToggleInsight(sid);
    };

    return (
        <tr
            style={rowStyle}
            onClick={onRowClick}
            onMouseEnter={onIntent}
            onFocus={onIntent}
        >
            <td style={{ textAlign: "center", width: 28 }}>
                <input
                    type="checkbox"
                    checked={isSelected ?? false}
                    onChange={() => onToggleSelect(sid)}
                    aria-label={`Select ${shortSessionId(s.id)} to compare`}
                />
            </td>
            <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, paddingLeft: indent ? 32 : 8, whiteSpace: "nowrap" }}>
                {hasInsight ? (
                    <button
                        type="button"
                        onClick={() => onToggleInsight(sid)}
                        aria-expanded={open}
                        aria-controls={panelId}
                        title={open ? "Collapse insight panel" : "Expand insight panel"}
                        style={{
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            cursor: "pointer",
                            display: "inline-block",
                            width: 12,
                            marginRight: 4,
                            color: "var(--sx-ink-500)",
                            transform: open ? "rotate(90deg)" : "rotate(0deg)",
                            transition: "transform 120ms ease",
                            fontFamily: "inherit",
                            fontSize: 12,
                            lineHeight: 1,
                        }}
                    >
                        ▶
                    </button>
                ) : null}
                {hasExpandedToggle ? (
                    <button
                        onClick={() => onToggleExpanded(sid)}
                        style={{
                            border: "none", background: "transparent", cursor: "pointer",
                            padding: "0 6px 0 0", fontFamily: "inherit", fontSize: 12, color: "var(--muted)",
                        }}
                        title={`${expanded ? "Collapse" : "Expand"} ${childCount} subagent${childCount === 1 ? "" : "s"}`}
                    >
                        {expanded ? "▼" : "▶"} {childCount}
                        {childLoading ? " …" : ""}
                    </button>
                ) : indent ? (
                    <span style={{ color: "var(--muted-2)", marginRight: 6 }}>↳</span>
                ) : (
                    <span style={{ display: "inline-block", width: 32 }} />
                )}
                {s.is_live ? (
                    <span
                        title="Live session"
                        style={{
                            display: "inline-block",
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: "var(--sx-green-700)",
                            boxShadow: "0 0 0 3px var(--sx-green-100)",
                            margin: "0 5px 1px 1px",
                            verticalAlign: "middle",
                        }}
                    >
                        <span className="sr-only">live session</span>
                    </span>
                ) : null}
                <code title={s.id} style={{ marginLeft: 4 }}>{shortSessionId(s.id)}</code>
            </td>
            <td><SourceBadge source={s.source} /></td>
            <td>{project}</td>
            <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--muted)" }}>{fmtTs(s.started_at)}</td>
            <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--muted)", textAlign: "right" }}>{fmtDuration(s.started_at, s.ended_at)}</td>
            <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12, fontVariantNumeric: "tabular-nums", color: s.turn_count > 0 ? "var(--ink)" : "var(--muted-2)" }}>{s.turn_count > 0 ? s.turn_count.toLocaleString() : "-"}</td>
            <td style={{ textAlign: "center", padding: "6px 8px" }}>
                <BurnSpark buckets={s.burn_buckets} p90={burnP90 ?? null} turnCount={s.turn_count > 0 ? s.turn_count : null} />
            </td>
            <td style={{ textAlign: "right", fontFamily: "ui-monospace, monospace", fontSize: 12, fontVariantNumeric: "tabular-nums", color: s.cost_usd != null ? "var(--ink)" : "var(--sx-ink-300)" }}>
                {s.cost_usd != null ? `$${s.cost_usd.toFixed(2)}` : "–"}
            </td>
            <td style={{ textAlign: "left", padding: "6px 8px" }}>
                <SignalBadge signal={s.signal} friction={s.friction} />
            </td>
            <td style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {s.has_raw_file ? (
                    <Link to="/sessions/$sessionId" params={{ sessionId: sid }} preload="intent" style={{ color: "var(--blue)", fontWeight: 600 }}>
                        open →
                    </Link>
                ) : (
                    <span style={{ color: "var(--muted-2)", fontSize: 11 }} title="No raw transcript stored - cannot inspect">no transcript</span>
                )}
            </td>
        </tr>
    );
});

/** Number of direct children for a root row. Uses the server-supplied count
 *  (which is always present on `/api/sessions` rows). */
const childCountOf = (row: SessionListRow): number => row.direct_children_count ?? 0;

// keep in sync with the <th> list below
const COL_COUNT = 11;

const PAGE_SIZE = 200;

export function SessionsRoute() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [insightOpen, setInsightOpen] = useState<ReadonlySet<string>>(() => new Set());
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

    const toggleSelected = useCallback((id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const compareSelected = () => {
        const ids = Array.from(selected);
        if (ids.length < 2) return;
        void navigate({
            to: "/sessions/compare",
            search: { ids: ids.join(","), turns: true },
        });
    };

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
                // why total_count diverges from recall.tsx (which preserves prev.total_count):
                // sessions list can grow under concurrent ingest; a stale total misleads the
                // "X of Y roots" meta line and could keep the IntersectionObserver firing
                // past the true end.
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
    // TODO: direct_children_count is computed at fetch time. If ingest writes new children mid-session, the displayed count won't refresh until the user reloads the roots query. Acceptable for v0.1.
    const expandedIds = useMemo(() => Array.from(expanded), [expanded]);
    const childQueries = useQueries({
        queries: expandedIds.map((id) => ({
            queryKey: ["session-children", id] as const,
            queryFn: () => api.sessionChildren(id),
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

    const toggleExpanded = useCallback((id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleInsight = useCallback((id: string) => {
        setInsightOpen((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

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
                                border: "1px solid var(--line)",
                                background: sourceFilter === f ? "var(--ink)" : "#fff",
                                color: sourceFilter === f ? "#fff" : "var(--muted)",
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
                    style={{ flex: 1, maxWidth: 360, padding: "4px 8px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 4 }}
                />
                {allExpandableIds.length > 0 ? (
                    <button
                        onClick={() => setExpanded((prev) =>
                            prev.size === allExpandableIds.length ? new Set() : new Set(allExpandableIds),
                        )}
                        style={{
                            padding: "4px 10px", fontSize: 11, border: "1px solid var(--line)",
                            background: "#fff", color: "var(--muted)", borderRadius: 4, cursor: "pointer",
                        }}
                    >
                        {expanded.size === allExpandableIds.length ? "collapse all" : "expand all"}
                    </button>
                ) : null}
                <button
                    onClick={compareSelected}
                    disabled={selected.size < 2}
                    title={selected.size < 2 ? "Select 2+ sessions to compare" : `Compare ${selected.size} sessions`}
                    style={{
                        padding: "4px 12px", fontSize: 11, fontWeight: 600,
                        border: "1px solid var(--line)", borderRadius: 4,
                        background: selected.size >= 2 ? "var(--ink)" : "#fff",
                        color: selected.size >= 2 ? "#fff" : "var(--muted-2)",
                        cursor: selected.size >= 2 ? "pointer" : "not-allowed",
                    }}
                >
                    compare{selected.size > 0 ? ` (${selected.size})` : ""}
                </button>
                {selected.size > 0 ? (
                    <button
                        onClick={() => setSelected(new Set())}
                        style={{
                            padding: "4px 8px", fontSize: 11, border: "1px solid var(--line)",
                            background: "#fff", color: "var(--muted)", borderRadius: 4, cursor: "pointer",
                        }}
                    >
                        clear
                    </button>
                ) : null}
            </div>
            {query.isLoading && !query.data ? <div className="loading">Loading…</div> : null}
            {query.data ? (
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                <table style={{ width: "100%", minWidth: 1120, borderCollapse: "collapse" }}>
                    <thead>
                        <tr style={{ background: "var(--page)", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            <th style={{ width: 28 }}></th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>id</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>source</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>project</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>started</th>
                            <th style={{ textAlign: "right", padding: "6px 8px" }}>duration</th>
                            <th style={{ textAlign: "right", padding: "6px 8px" }}>turns</th>
                            <th style={{ textAlign: "center", padding: "6px 8px" }}>burn</th>
                            <th style={{ textAlign: "right", padding: "6px 8px" }}>cost</th>
                            <th style={{ textAlign: "left", padding: "6px 8px" }}>signal</th>
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
                                        burnP90={query.data?.burn_p90 ?? null}
                                        insightOpen={insightOpen.has(parent.id)}
                                        onToggleInsight={toggleInsight}
                                        isSelected={selected.has(parent.id)}
                                        onToggleSelect={toggleSelected}
                                        {...(childCount > 0
                                            ? {
                                                childCount,
                                                childLoading: !!kidState?.loading,
                                                expanded: isExpanded,
                                                onToggleExpanded: toggleExpanded,
                                            }
                                            : {})}
                                    />
                                    {insightOpen.has(parent.id) ? (
                                        <tr id={`session-insight-${parent.id}`}>
                                            <td
                                                colSpan={COL_COUNT}
                                                style={{
                                                    padding: 0,
                                                    background: "var(--sx-tint-50)",
                                                    boxShadow: "inset 3px 0 0 var(--sx-ink-900)",
                                                    borderBottom: "1px solid var(--sx-line-200)",
                                                }}
                                            >
                                                <InsightPanel row={parent} />
                                            </td>
                                        </tr>
                                    ) : null}
                                    {isExpanded
                                        ? (kidState?.rows ?? []).map((child) => (
                                            <Row
                                                key={child.id}
                                                s={child}
                                                indent
                                                isSelected={selected.has(child.id)}
                                                onToggleSelect={toggleSelected}
                                            />
                                        ))
                                        : null}
                                </Fragment>
                            );
                        })}
                        {allRoots.length < totalCount ? (
                            <tr ref={sentinelRef}>
                                <td colSpan={COL_COUNT} style={{
                                    padding: "12px 24px", color: "var(--muted)", fontSize: 12,
                                    fontFamily: "ui-monospace, monospace",
                                    textAlign: "center", borderTop: "1px dashed var(--line)",
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
                                                    border: "1px solid var(--line)", background: "#fff",
                                                    color: "var(--muted)", borderRadius: 4, cursor: "pointer",
                                                }}
                                            >load {PAGE_SIZE} more</button>
                                        </>
                                    ) : null}
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
                </div>
            ) : null}
        </section>
    );
}
