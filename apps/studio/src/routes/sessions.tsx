import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { api } from "../api.ts";
// BurnSpark kept on disk; not rendered in viz/strip views (story bar replaces it as the visual)
// accordion view retired in favor of inline visuals; components kept for the session detail page
import { SignalBadge } from "../components/session-insight/SignalBadge.tsx";
import { StoryStrip } from "../components/session-insight/StoryStrip.tsx";
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

export const SOURCE_FILTERS = ["all", "claude", "codex", "pi", "omp", "opencode", "cursor"] as const;
type SourceFilter = typeof SOURCE_FILTERS[number];

/** One stable instrument hue per source - carried only by the swatch dot in
 *  the chip; the label text stays neutral mono. claude = green (house accent),
 *  the rest spread across the luminance-matched accent set. NOT orange. */
export const SOURCE_HUES: Record<string, string> = {
    claude: "var(--green)",
    codex: "var(--blue)",
    pi: "var(--gold)",
    omp: "color-mix(in srgb, var(--gold) 60%, var(--violet))",
    opencode: "var(--violet)",
    cursor: "color-mix(in srgb, var(--blue) 55%, var(--green))",
    "claude-subagent": "var(--dim)",
};

function SourceBadge({ source }: { source: string }) {
    const hue = SOURCE_HUES[source] ?? "var(--dim)";
    return (
        <span className="sx-src">
            <i className="sx-src-dot" style={{ background: hue }} aria-hidden="true" />
            {source}
        </span>
    );
}

/** ΔLOC two-bar cell: green (added) + red (removed) proportionally split over
 *  a fixed 72px total, magnitude encoded via log1p normalisation against maxLoc. */
function LocCell({ added, removed, maxLoc }: {
    readonly added: number | null;
    readonly removed: number | null;
    readonly maxLoc: number;
}) {
    if (added === null && removed === null) {
        return <span style={{ color: "var(--dim)", fontSize: 10 }}>-</span>;
    }
    const a = Math.max(0, added ?? 0);
    const r = Math.max(0, removed ?? 0);
    const total = a + r;
    const FIXED_W = 72;
    const scale = maxLoc > 0 ? Math.log1p(total) / Math.log1p(maxLoc) : 0;
    const barW = Math.round(FIXED_W * Math.min(1, scale));
    const greenW = total > 0 ? Math.round(barW * (a / total)) : 0;
    const redW = barW - greenW;

    const fmt = (n: number): string => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", width: FIXED_W }}>
                {greenW > 0
                    ? <span style={{ display: "inline-block", width: greenW, height: 5, background: "var(--green)", borderRadius: "1px 0 0 1px", opacity: 0.85 }} />
                    : null}
                {redW > 0
                    ? <span style={{ display: "inline-block", width: redW, height: 5, background: "var(--red)", borderRadius: greenW > 0 ? "0 1px 1px 0" : "1px", opacity: 0.85 }} />
                    : null}
            </span>
            <span style={{ fontSize: 10, fontFamily: "var(--mono)", fontVariantNumeric: "tabular-nums" }}>
                <span style={{ color: "var(--green)" }}>+{fmt(a)}</span>
                {" "}
                <span style={{ color: "var(--red)" }}>−{fmt(r)}</span>
            </span>
        </span>
    );
}

/** COMMITS cell: up to 8 green dots + ✕N reverted + +N overflow. */
function CommitsCell({ produced, reverted }: {
    readonly produced: number | null;
    readonly reverted: number | null;
}) {
    if (produced === null && reverted === null) {
        return <span style={{ color: "var(--dim)", fontSize: 10 }}>-</span>;
    }
    const p = produced ?? 0;
    const r = reverted ?? 0;
    const landed = Math.max(0, p - r);
    const MAX_DOTS = 8;
    const shown = Math.min(landed, MAX_DOTS);
    const overflow = landed - shown;
    return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
            {Array.from({ length: shown }, (_, i) => (
                <span
                    key={i}
                    style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--green)", opacity: 0.9 }}
                />
            ))}
            {overflow > 0
                ? <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--green)" }}>+{overflow}</span>
                : null}
            {r > 0
                ? <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--red)", marginLeft: overflow > 0 ? 0 : 2 }}>✕{r}</span>
                : null}
            {p === 0 && r === 0
                ? <span style={{ color: "var(--dim)", fontSize: 10 }}>-</span>
                : null}
        </span>
    );
}

// keep in sync with the <th> list below
// ☐ ID SRC PROJECT STARTED DUR TURNS STORY ΔLOC COMMITS COST SIGNAL → link
const COL_COUNT = 12;

interface RowProps {
    readonly s: SessionListRow;
    readonly indent?: boolean;
    readonly maxLoc: number;
    // Expanded-toggle props (root rows with children only)
    readonly childCount?: number;
    readonly childLoading?: boolean;
    readonly expanded?: boolean;
    readonly onToggleExpanded?: (id: string) => void;
    // Selection props (all rows)
    readonly isSelected?: boolean;
    readonly onToggleSelect: (id: string) => void;
}

const Row = memo(function Row({
    s,
    indent,
    maxLoc,
    childCount,
    childLoading,
    expanded,
    onToggleExpanded,
    isSelected,
    onToggleSelect,
}: RowProps) {
    const sid = s.id;
    const project = sessionProjectLabel(s.project, s.cwd);
    const hasExpandedToggle = onToggleExpanded != null && childCount != null && childCount > 0;

    const navigate = useNavigate();
    const openSession = useCallback(() => {
        if (!s.has_raw_file) return;
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: sid } });
    }, [navigate, sid, s.has_raw_file]);

    // Warm the inspect-data query on hover/focus - intent-based prefetch
    const queryClient = useQueryClient();
    const onIntent = () => {
        if (!s.has_raw_file) return;
        void queryClient.prefetchQuery({
            queryKey: ["session-inspect", sid],
            queryFn: () => api.sessionInspect(sid),
            staleTime: 5 * 60_000,
        });
    };
    // Whole row is a click target (any cell except the interactive controls -
    // checkbox / expand toggle / explicit links - which stopPropagation).
    const onRowClick = () => openSession();

    return (
        <tr
            className={`${indent ? "is-child" : ""}${s.has_raw_file ? " is-openable" : ""}`.trim() || undefined}
            onMouseEnter={onIntent}
            onFocus={onIntent}
            onClick={onRowClick}
        >
            <td style={{ textAlign: "center", width: 28 }} onClick={(e) => e.stopPropagation()}>
                <input
                    type="checkbox"
                    checked={isSelected ?? false}
                    onChange={() => onToggleSelect(sid)}
                    aria-label={`Select ${shortSessionId(s.id)} to compare`}
                />
            </td>
            <td className="sx-id" style={{ paddingLeft: indent ? 32 : 8, whiteSpace: "nowrap" }}>
                {hasExpandedToggle ? (
                    <button
                        className="sx-expand"
                        onClick={(e) => { e.stopPropagation(); onToggleExpanded(sid); }}
                        title={`${expanded ? "Collapse" : "Expand"} ${childCount} subagent${childCount === 1 ? "" : "s"}`}
                    >
                        {expanded ? "▼" : "▶"} {childCount}
                        {childLoading ? " …" : ""}
                    </button>
                ) : indent ? (
                    <span className="sx-child-mark">↳</span>
                ) : (
                    <span style={{ display: "inline-block", width: 32 }} />
                )}
                {s.is_live ? (
                    <span className="sx-live" title="Live session">
                        <span className="sr-only">live session</span>
                    </span>
                ) : null}
                {s.has_raw_file ? (
                    <Link
                        to="/sessions/$sessionId"
                        params={{ sessionId: sid }}
                        preload="intent"
                        className="sx-id-link"
                        title={`Open ${s.id}`}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <code>{shortSessionId(s.id)}</code>
                    </Link>
                ) : (
                    <code title={s.id} style={{ marginLeft: 4, color: "var(--dim)" }}>{shortSessionId(s.id)}</code>
                )}
            </td>
            <td><SourceBadge source={s.source} /></td>
            <td className="sx-project">{project}</td>
            <td className="sx-meta">{fmtTs(s.started_at)}</td>
            <td className="sx-meta" style={{ textAlign: "right" }}>{fmtDuration(s.started_at, s.ended_at)}</td>
            <td className={`sx-num${s.turn_count > 0 ? "" : " is-zero"}`} style={{ textAlign: "right" }}>{s.turn_count > 0 ? s.turn_count.toLocaleString() : "-"}</td>
            <td style={{ textAlign: "center", padding: "6px 8px" }}>
                <StoryStrip
                    sessionId={sid}
                    startedAt={s.started_at}
                    endedAt={s.ended_at}
                />
            </td>
            <td style={{ padding: "4px 8px" }}>
                <LocCell
                    added={s.lines_added}
                    removed={s.lines_removed}
                    maxLoc={maxLoc}
                />
            </td>
            <td style={{ padding: "4px 8px" }}>
                <CommitsCell
                    produced={s.produced_commits}
                    reverted={s.reverted_commits}
                />
            </td>
            <td className={`sx-num${s.cost_usd != null ? "" : " is-zero"}`} style={{ textAlign: "right" }}>
                {s.cost_usd != null ? `$${s.cost_usd.toFixed(2)}` : "–"}
            </td>
            <td style={{ textAlign: "left", padding: "6px 8px" }}>
                <SignalBadge signal={s.signal} friction={s.friction} />
            </td>
            <td style={{ whiteSpace: "nowrap" }}>
                {s.has_raw_file ? (
                    <Link
                        to="/sessions/$sessionId"
                        params={{ sessionId: sid }}
                        preload="intent"
                        className="sx-open"
                        onClick={(e) => e.stopPropagation()}
                    >
                        open →
                    </Link>
                ) : (
                    <span className="sx-notx" title="No raw transcript stored - cannot inspect">no transcript</span>
                )}
            </td>
        </tr>
    );
});

/** Number of direct children for a root row. */
const childCountOf = (row: SessionListRow): number => row.direct_children_count ?? 0;

const PAGE_SIZE = 200;

export function SessionsRoute() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
    const [search, setSearch] = useState("");
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
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

    const rootsWithChildren = useMemo(
        () => filteredRoots.reduce((n, r) => n + (childCountOf(r) > 0 ? 1 : 0), 0),
        [filteredRoots],
    );

    // Precompute maxLoc for the ΔLOC column normalisation (log1p scale).
    const maxLoc = useMemo(() => {
        let max = 1;
        for (const r of filteredRoots) {
            const total = (r.lines_added ?? 0) + (r.lines_removed ?? 0);
            if (total > max) max = total;
        }
        return max;
    }, [filteredRoots]);

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

    const allExpandableIds = useMemo(
        () => filteredRoots.filter((r) => childCountOf(r) > 0).map((r) => r.id),
        [filteredRoots],
    );

    return (
        <section className="panel sessions-instrument">
            <header className="inst-head">
                <div className="inst-head-top">
                    <div>
                        <div className="inst-kicker">$ ax sessions</div>
                        <h2 className="inst-title">Sessions</h2>
                        {query.data ? (
                            <div className="inst-head-meta" style={{ marginTop: 8 }}>
                                <b>{allRoots.length.toLocaleString()}</b> of{" "}
                                <b>{totalCount.toLocaleString()}</b> roots
                                <span>·</span>
                                <b>{rootsWithChildren.toLocaleString()}</b> with subagents
                                {search ? (
                                    <>
                                        <span>·</span>
                                        <b>{filteredRoots.length.toLocaleString()}</b> match search
                                    </>
                                ) : null}
                                <span>·</span>
                                <span className="live">
                                    <span className="rdx-led" aria-hidden="true" />live
                                </span>
                            </div>
                        ) : null}
                    </div>
                    {query.data ? (
                        <div className="inst-hero">
                            <span className="rdx-doto n">{totalCount.toLocaleString()}</span>
                            <span className="l">sessions traced</span>
                        </div>
                    ) : null}
                </div>
            </header>
            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            <div className="inst-controls">
                {SOURCE_FILTERS.map((f) => (
                    <button
                        key={f}
                        type="button"
                        className={`inst-chip${sourceFilter === f ? " is-active" : ""}`}
                        onClick={() => setSourceFilter(f)}
                    >
                        {f}
                    </button>
                ))}
                <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="search id / project / cwd / model"
                    className="inst-search"
                    aria-label="search sessions"
                />
                {allExpandableIds.length > 0 ? (
                    <button
                        type="button"
                        className="inst-chip"
                        onClick={() => setExpanded((prev) =>
                            prev.size === allExpandableIds.length ? new Set() : new Set(allExpandableIds),
                        )}
                    >
                        {expanded.size === allExpandableIds.length ? "collapse all" : "expand all"}
                    </button>
                ) : null}
                <button
                    type="button"
                    className={`inst-chip${selected.size >= 2 ? " is-active" : ""}`}
                    onClick={compareSelected}
                    disabled={selected.size < 2}
                    title={selected.size < 2 ? "Select 2+ sessions to compare" : `Compare ${selected.size} sessions`}
                >
                    compare{selected.size > 0 ? ` (${selected.size})` : ""}
                </button>
                {selected.size > 0 ? (
                    <button
                        type="button"
                        className="inst-chip"
                        onClick={() => setSelected(new Set())}
                    >
                        clear
                    </button>
                ) : null}
            </div>
            {query.isLoading && !query.data ? <div className="loading">Loading…</div> : null}
            {query.data ? (
                <div className="sx-scroll">
                <table className="sx-sessions">
                    <thead>
                        <tr>
                            <th style={{ width: 28 }}></th>
                            <th style={{ textAlign: "left" }}>id</th>
                            <th style={{ textAlign: "left" }}>source</th>
                            <th style={{ textAlign: "left" }}>project</th>
                            <th style={{ textAlign: "left" }}>started</th>
                            <th style={{ textAlign: "right" }}>duration</th>
                            <th style={{ textAlign: "right" }}>turns</th>
                            <th style={{ textAlign: "center" }}>story</th>
                            <th style={{ textAlign: "left" }}>δloc</th>
                            <th style={{ textAlign: "left" }}>commits</th>
                            <th style={{ textAlign: "right" }}>cost</th>
                            <th style={{ textAlign: "left" }}>signal</th>
                            <th style={{ textAlign: "left" }}></th>
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
                                        maxLoc={maxLoc}
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
                                    {isExpanded
                                        ? (kidState?.rows ?? []).map((child) => (
                                            <Row
                                                key={child.id}
                                                s={child}
                                                indent
                                                maxLoc={maxLoc}
                                                isSelected={selected.has(child.id)}
                                                onToggleSelect={toggleSelected}
                                            />
                                        ))
                                        : null}
                                </Fragment>
                            );
                        })}
                        {allRoots.length < totalCount ? (
                            <tr ref={sentinelRef} className="sx-sentinel">
                                <td colSpan={COL_COUNT}>
                                    {appendLoading
                                        ? `loading next ${PAGE_SIZE} of ${totalCount.toLocaleString()}…`
                                        : `loaded ${allRoots.length.toLocaleString()} of ${totalCount.toLocaleString()} ·`}
                                    {!appendLoading ? (
                                        <button
                                            type="button"
                                            className="sx-loadmore"
                                            onClick={() => void loadMore(PAGE_SIZE)}
                                        >load {PAGE_SIZE} more</button>
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
