import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { InspectSpanDto, InspectSpanKind, InspectTurnDto } from "@shared/dashboard-types.ts";
import {
    isCorrectionTurn,
    isRoleTurn,
    isSpawnAnchorTurn,
    matchesSearch,
    matchingSeqs,
    nextMatchAfter,
    spawnAnchorSet,
} from "./inspector-filters.ts";

interface KindStyle { bg: string; fg: string; bar: string; label: string }
const KIND_STYLE: Record<InspectSpanKind, KindStyle> = {
    user_input:            { bg: "#fef9c3", fg: "#78350f", bar: "#eab308", label: "user input" },
    assistant_text:        { bg: "#f3f4f6", fg: "#111827", bar: "#0f172a", label: "assistant text" },
    tool_use:              { bg: "#ede9fe", fg: "#4c1d95", bar: "#8b5cf6", label: "tool use" },
    skill_context:         { bg: "#dbeafe", fg: "#1e3a8a", bar: "#3b82f6", label: "skill" },
    system_context:        { bg: "#e5e7eb", fg: "#1f2937", bar: "#64748b", label: "system" },
    wrapper_instruction:   { bg: "#fde68a", fg: "#92400e", bar: "#f59e0b", label: "wrapper" },
    hook_injection:        { bg: "#bbf7d0", fg: "#065f46", bar: "#10b981", label: "hook" },
    tool_result:           { bg: "#e9d5ff", fg: "#5b21b6", bar: "#a855f7", label: "tool result" },
    subagent_notification: { bg: "#fed7aa", fg: "#9a3412", bar: "#f97316", label: "subagent notif" },
    subagent_task:         { bg: "#ffe4e6", fg: "#9f1239", bar: "#e11d48", label: "subagent task" },
    pasted_reference:      { bg: "#fecaca", fg: "#7f1d1d", bar: "#ef4444", label: "pasted" },
};

const shortId = (id: string): string =>
    id.replace(/^session:⟨/, "").replace(/⟩$/, "").slice(0, 12) + "…";

const bareId = (id: string): string => {
    let s = id.startsWith("session:") ? id.slice("session:".length) : id;
    s = s.replace(/^[`⟨]+/, "").replace(/[`⟩]+$/, "");
    return s;
};

function Span({ span }: { span: InspectSpanDto }) {
    const s = KIND_STYLE[span.kind];
    const title = span.label ? `${s.label}: ${span.label}` : s.label;
    return (
        <span style={{ background: s.bg, color: s.fg, padding: "0 1px", borderRadius: 2 }} title={title}>
            {span.text}
        </span>
    );
}

interface SpawnMetaDto {
    readonly provider: string;
    readonly agent_type: string | null;
    readonly fork_context: boolean | null;
    readonly reasoning_effort: string | null;
    readonly brief: string | null;
}

interface SpawnChildDto {
    readonly session_id: string;
    readonly nickname: string | null;
    readonly tool: string | null;
    readonly ts: string | null;
    readonly meta: SpawnMetaDto | null;
}

function SpawnMarker({ child }: { child: SpawnChildDto }) {
    const childBare = bareId(child.session_id);
    const ts = child.ts ? new Date(child.ts).toISOString().slice(11, 19) : "";
    const m = child.meta;
    const chips: Array<{ label: string; value: string }> = [];
    if (m?.agent_type) chips.push({ label: "type", value: m.agent_type });
    if (m?.reasoning_effort) chips.push({ label: "effort", value: m.reasoning_effort });
    if (m?.fork_context != null) chips.push({ label: "fork", value: m.fork_context ? "yes" : "no" });

    // Prefetch the spawned child's inspect data on hover/focus only -
    // mass-prefetching all 52 spawn markers at once would stampede the API.
    const queryClient = useQueryClient();
    const onIntent = () => {
        void queryClient.prefetchQuery({
            queryKey: ["session-inspect", childBare],
            queryFn: () => api.sessionInspect(childBare),
            staleTime: 5 * 60_000,
        });
    };

    const [expanded, setExpanded] = useState(false);
    const brief = m?.brief ?? null;
    const briefClippedLen = 200;
    const briefIsLong = !!brief && brief.length > briefClippedLen;

    return (
        <div onMouseEnter={onIntent} onFocus={onIntent} style={{
            margin: "4px 0", padding: "6px 10px", background: "#ffe4e6",
            borderLeft: "3px solid #e11d48", borderRadius: 3, fontSize: 11,
            fontFamily: "ui-monospace, monospace", color: "#9f1239",
        }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>→ spawned</span>
                <Link
                    to="/sessions/$sessionId/inspect"
                    params={{ sessionId: childBare }}
                    preload="intent"
                    style={{ color: "#9f1239", fontWeight: 600 }}
                >
                    {child.nickname ? `"${child.nickname}"` : `${childBare.slice(0, 12)}…`}
                </Link>
                {child.nickname ? <span style={{ opacity: 0.6 }}>{childBare.slice(0, 10)}…</span> : null}
                {child.tool ? <span style={{ opacity: 0.6 }}>via {child.tool}</span> : null}
                {m ? <span style={{ background: "#fecdd3", color: "#7f1d1d", padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>{m.provider}</span> : null}
                {chips.map((c) => (
                    <span key={c.label} style={{ background: "#fee2e2", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                        {c.label}: <strong>{c.value}</strong>
                    </span>
                ))}
                <span style={{ opacity: 0.6, marginLeft: "auto" }}>{ts}</span>
            </div>
            {brief ? (
                <div style={{ marginTop: 4, color: "#7f1d1d", opacity: 0.9, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    <span style={{ fontStyle: "italic" }}>
                        “{expanded || !briefIsLong ? brief : `${brief.slice(0, briefClippedLen - 1)}…`}”
                    </span>
                    {briefIsLong ? (
                        <button
                            onClick={() => setExpanded((v) => !v)}
                            style={{
                                marginLeft: 6, padding: "0 6px", fontSize: 10, fontFamily: "inherit",
                                background: "transparent", border: "1px solid #fecdd3", borderRadius: 3,
                                color: "#9f1239", cursor: "pointer",
                            }}
                        >
                            {expanded ? "show less" : `show full (${brief.length.toLocaleString()}c)`}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function Turn({ turn, anchored, childrenSpawnedHere }: { turn: InspectTurnDto; anchored: boolean; childrenSpawnedHere?: ReadonlyArray<SpawnChildDto> }) {
    const s = KIND_STYLE[turn.semantic_role];
    const kindCounts = new Map<InspectSpanKind, number>();
    for (const sp of turn.spans) kindCounts.set(sp.kind, (kindCounts.get(sp.kind) ?? 0) + sp.text.length);
    const total = turn.char_count;
    const chips = [...kindCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, n]) => {
            const c = KIND_STYLE[kind];
            const pct = total > 0 ? ((n / total) * 100).toFixed(0) : "0";
            return (
                <span key={kind} style={{ background: c.bg, color: c.fg, padding: "0 6px", borderRadius: 3, fontSize: 10, fontFamily: "ui-monospace, monospace" }}>
                    {c.label} {pct}%
                </span>
            );
        });
    const ts = turn.ts ? new Date(turn.ts).toISOString().slice(11, 19) : "";
    const sizeStr = turn.char_count > 1000 ? `${(turn.char_count / 1000).toFixed(1)}k` : `${turn.char_count}`;
    const jsonlBadge = turn.role !== turn.semantic_role.replace(/_text$|_input$/, "")
        ? <span style={{ color: "#94a3b8", fontSize: 10 }}>(jsonl: {turn.role})</span>
        : null;
    return (
        <div
            id={`turn-${turn.seq}`}
            style={{
                display: "grid",
                gridTemplateColumns: "1fr",
                padding: "6px 24px",
                borderLeft: `3px solid ${s.bar}`,
                background: anchored ? "#fef3c7" : "transparent",
                transition: "background 0.6s",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "#64748b", flexWrap: "wrap", fontFamily: "ui-monospace, monospace" }}>
                <a href={`#turn-${turn.seq}`} style={{ color: "#94a3b8", textDecoration: "none", minWidth: 48 }}>#{turn.seq}</a>
                <span style={{ background: s.bg, color: s.fg, padding: "1px 8px", borderRadius: 3, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {s.label}
                </span>
                {jsonlBadge}
                <span style={{ color: "#94a3b8" }}>{ts}</span>
                <span style={{ color: "#94a3b8" }}>{sizeStr}c · {turn.spans.length}span</span>
                <span style={{ display: "inline-flex", gap: 3, flexWrap: "wrap", marginLeft: "auto" }}>{chips}</span>
            </div>
            <pre style={{ margin: 0, padding: "4px 0 6px", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.55 ui-monospace, monospace", maxHeight: 400, overflow: "auto" }}>
                {turn.spans.map((sp, i) => <Span key={i} span={sp} />)}
            </pre>
            {childrenSpawnedHere && childrenSpawnedHere.length > 0 ? (
                <div style={{ padding: "0 0 4px" }}>
                    {childrenSpawnedHere.map((c) => (
                        <SpawnMarker key={c.session_id} child={c} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

interface FilterBarProps {
    readonly turns: ReadonlyArray<InspectTurnDto>;
    readonly anchorSeqs: ReadonlySet<number>;
    readonly currentSeq: number | null;
    readonly loadedCount: number;
    readonly totalCount: number;
    readonly appendLoading: boolean;
    readonly loadMore: (count?: number) => Promise<void>;
    /** Returns the latest `turns` array - bypasses prop staleness across an
     *  `await loadMore()` boundary so retry-after-load can see new entries. */
    readonly getTurns: () => ReadonlyArray<InspectTurnDto>;
    /** Same as above for the hash-derived cursor seq. */
    readonly getCurrentSeq: () => number | null;
}

type QuickFilter =
    | { key: "correction"; label: string; pred: (t: InspectTurnDto) => boolean }
    | { key: "spawn"; label: string; pred: (t: InspectTurnDto) => boolean }
    | { key: InspectSpanKind; label: string; pred: (t: InspectTurnDto) => boolean };

function FilterBar({
    turns,
    anchorSeqs,
    currentSeq,
    loadedCount,
    totalCount,
    appendLoading,
    loadMore,
    getTurns,
    getCurrentSeq,
}: FilterBarProps) {
    const [searchInput, setSearchInput] = useState("");
    const [searchQuery, setSearchQuery] = useState("");

    // Debounce free-text input → searchQuery (~250 ms).
    useEffect(() => {
        const handle = window.setTimeout(() => setSearchQuery(searchInput), 250);
        return () => window.clearTimeout(handle);
    }, [searchInput]);

    const quickFilters: ReadonlyArray<QuickFilter> = useMemo(() => [
        { key: "correction",     label: "next correction",  pred: isCorrectionTurn },
        { key: "spawn",          label: "next spawn",       pred: (t) => isSpawnAnchorTurn(t, anchorSeqs) },
        { key: "tool_use",       label: "next tool_use",    pred: (t) => isRoleTurn(t, "tool_use") },
        { key: "tool_result",    label: "next tool_result", pred: (t) => isRoleTurn(t, "tool_result") },
        { key: "hook_injection", label: "next hook",        pred: (t) => isRoleTurn(t, "hook_injection") },
    ], [anchorSeqs]);

    // Precompute matching seqs per filter against the currently-loaded window.
    // If the filter yields nothing in the loaded window AND we haven't loaded
    // everything yet, the button stays enabled and clicking will trigger a
    // bigger page fetch (handled in handleJump).
    const matchesByKey = useMemo(() => {
        const m = new Map<string, ReadonlyArray<number>>();
        for (const f of quickFilters) m.set(f.key, matchingSeqs(turns, f.pred));
        return m;
    }, [turns, quickFilters]);

    const searchSeqs = useMemo<ReadonlyArray<number>>(() => {
        const q = searchQuery.trim();
        if (q.length === 0) return [];
        return matchingSeqs(turns, (t) => matchesSearch(t, q));
    }, [turns, searchQuery]);

    const fullyLoaded = loadedCount >= totalCount;

    const jumpTo = (seq: number) => {
        // Setting the hash triggers our hashchange listener, which updates
        // anchoredSeq → re-fires the scroll + auto-load useEffects. The
        // browser steals focus to the hash target on navigation, so preserve
        // the previously-focused element (typically the search input) so
        // repeated Enter / button-clicks keep working without re-focusing.
        const prevFocus = document.activeElement as HTMLElement | null;
        if (window.location.hash === `#turn-${seq}`) {
            const el = document.getElementById(`turn-${seq}`);
            if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
        } else {
            window.location.hash = `#turn-${seq}`;
        }
        if (prevFocus && typeof prevFocus.focus === "function" && prevFocus !== document.body) {
            // Restore on the next frame, after the browser's hash-focus steal.
            window.requestAnimationFrame(() => prevFocus.focus({ preventScroll: true }));
        }
    };

    const handleJump = async (pred: (t: InspectTurnDto) => boolean) => {
        // Always recompute matches and cursor from refs - the closure may be
        // stale across rapid repeat clicks faster than React re-renders.
        const seqs = matchingSeqs(getTurns(), pred);
        const next = nextMatchAfter(seqs, getCurrentSeq());
        if (next != null) { jumpTo(next); return; }
        // No match in loaded window. If pagination still has pages, load
        // everything and retry once against the fresh data.
        if (fullyLoaded || appendLoading) return;
        await loadMore(totalCount - loadedCount);
        const fresh = matchingSeqs(getTurns(), pred);
        const retry = nextMatchAfter(fresh, getCurrentSeq());
        if (retry != null) jumpTo(retry);
    };

    const jumpSearch = () => {
        const q = searchInput.trim();
        if (q.length === 0) return;
        // Force immediate apply (skip debounce) on Enter so the visible hit
        // counter matches what the jump uses.
        setSearchQuery(searchInput);
        // Always read via refs so rapid repeat-Enter (faster than React's
        // re-render) sees the freshest cursor and turn list.
        const fresh = matchingSeqs(getTurns(), (t) => matchesSearch(t, q));
        const next = nextMatchAfter(fresh, getCurrentSeq());
        if (next != null) { jumpTo(next); return; }
        if (fullyLoaded || appendLoading) return;
        void loadMore(totalCount - loadedCount).then(() => {
            const after = matchingSeqs(getTurns(), (t) => matchesSearch(t, q));
            const retry = nextMatchAfter(after, getCurrentSeq());
            if (retry != null) jumpTo(retry);
        });
    };

    const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            jumpSearch();
        }
    };

    const btnStyle = (enabled: boolean): React.CSSProperties => ({
        padding: "3px 10px",
        fontSize: 11,
        fontFamily: "ui-monospace, monospace",
        border: "1px solid #e2e8f0",
        background: enabled ? "#fff" : "#f1f5f9",
        color: enabled ? "#475569" : "#94a3b8",
        borderRadius: 4,
        cursor: enabled ? "pointer" : "not-allowed",
    });

    return (
        <div style={{
            display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center",
            padding: "6px 24px", borderTop: "1px solid #e2e8f0", background: "#f8fafc",
            fontFamily: "ui-monospace, monospace", fontSize: 11,
        }}>
            <span style={{ color: "#64748b", marginRight: 4 }}>jump:</span>
            {quickFilters.map((f) => {
                const seqs = matchesByKey.get(f.key) ?? [];
                // Button is "enabled" if matches exist in window OR pagination
                // can still discover more. We never permanently disable until
                // the full session is loaded and zero matches were found.
                const hasMatches = seqs.length > 0;
                const canDiscoverMore = !fullyLoaded;
                const enabled = (hasMatches || canDiscoverMore) && !appendLoading;
                const count = hasMatches ? ` (${seqs.length})` : "";
                const title = !hasMatches && fullyLoaded
                    ? "no matches in this session"
                    : !hasMatches
                        ? `no matches in loaded ${loadedCount.toLocaleString()} turns - click to load more`
                        : `${seqs.length} match${seqs.length === 1 ? "" : "es"} in loaded window`;
                return (
                    <button
                        key={f.key}
                        onClick={() => { void handleJump(f.pred); }}
                        disabled={!enabled}
                        title={title}
                        style={btnStyle(enabled)}
                    >
                        {f.label}{count}
                    </button>
                );
            })}
            <div style={{ display: "flex", gap: 4, marginLeft: 8, alignItems: "center", flex: "1 1 220px", minWidth: 180 }}>
                <input
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={onSearchKeyDown}
                    placeholder="find in turns (Enter to jump)…"
                    style={{
                        flex: 1, padding: "3px 8px", fontSize: 11, fontFamily: "inherit",
                        border: "1px solid #e2e8f0", borderRadius: 4, background: "#fff",
                        color: "#1f2937", minWidth: 0,
                    }}
                />
                <button
                    type="button"
                    onClick={jumpSearch}
                    disabled={searchInput.trim().length === 0}
                    title="jump to next match (or press Enter)"
                    style={btnStyle(searchInput.trim().length > 0)}
                >
                    next
                </button>
                {searchQuery.trim().length > 0 ? (
                    <span style={{ color: searchSeqs.length > 0 ? "#475569" : "#ef4444" }}>
                        {searchSeqs.length > 0
                            ? `${searchSeqs.length} hit${searchSeqs.length === 1 ? "" : "s"}`
                            : (fullyLoaded ? "no hits" : "no hits in loaded window")}
                    </span>
                ) : null}
            </div>
        </div>
    );
}

export function SessionInspectRoute() {
    const { sessionId } = useParams({ from: "/sessions/$sessionId/inspect" });
    const decoded = decodeURIComponent(sessionId);
    const queryClient = useQueryClient();

    // Server-side pagination. Initial fetch pulls metadata + first PAGE_SIZE
    // turns (small payload). Subsequent pages append to the in-memory copy.
    const PAGE_SIZE = 100;
    const baseKey = ["session-inspect", decoded] as const;
    const query = useQuery({
        queryKey: baseKey,
        queryFn: () => api.sessionInspect(decoded, { turnOffset: 0, turnLimit: PAGE_SIZE }),
    });
    const data = query.data ?? null;
    const [appendLoading, setAppendLoading] = useState(false);

    // Deep-link to a specific turn via #turn-N (set by URL, page load, or
    // programmatically by the filter bar). Re-read on every hashchange so
    // jump buttons can move the cursor and re-trigger scroll/auto-load.
    const readHashSeq = (): number | null => {
        if (typeof window === "undefined") return null;
        const m = window.location.hash.match(/^#turn-(\d+)$/);
        return m ? Number(m[1]) : null;
    };
    const [anchoredSeq, setAnchoredSeq] = useState<number | null>(() => readHashSeq());
    useEffect(() => {
        if (typeof window === "undefined") return;
        const onHashChange = () => setAnchoredSeq(readHashSeq());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    /** Fetch the next page of turns and append them to the cached payload. */
    const loadMore = async (count: number = PAGE_SIZE) => {
        if (!data) return;
        if (data.turns.length >= data.total_turns) return;
        if (appendLoading) return;
        setAppendLoading(true);
        try {
            const page = await api.sessionInspect(decoded, {
                turnOffset: data.turns.length,
                turnLimit: count,
            });
            queryClient.setQueryData<typeof data>(baseKey, (prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    turns: [...prev.turns, ...page.turns],
                    turn_window: { offset: 0, limit: prev.turns.length + page.turns.length },
                };
            });
        } finally {
            setAppendLoading(false);
        }
    };

    // If the user deep-linked to a turn past the loaded set, request enough
    // pages to include it before scrolling.
    useEffect(() => {
        if (anchoredSeq == null || !data) return;
        if (anchoredSeq < data.turns.length) return;
        const needed = anchoredSeq + 20 - data.turns.length;
        void loadMore(Math.max(needed, PAGE_SIZE));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [anchoredSeq, data]);

    useEffect(() => {
        if (anchoredSeq == null || !data) return;
        const el = document.getElementById(`turn-${anchoredSeq}`);
        if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
    }, [anchoredSeq, data]);

    // Refs that always reflect the latest values - used by FilterBar handlers
    // that need to read state after `await loadMore()` resolves.
    const turnsRef = useRef<ReadonlyArray<InspectTurnDto>>(data?.turns ?? []);
    turnsRef.current = data?.turns ?? [];
    const anchoredSeqRef = useRef<number | null>(anchoredSeq);
    anchoredSeqRef.current = anchoredSeq;

    // Anchor seqs for the "next spawn" filter, recomputed when children change.
    const anchorSeqs = useMemo(
        () => spawnAnchorSet(data?.children ?? []),
        [data?.children],
    );

    // IntersectionObserver on a sentinel triggers the next page load.
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!data) return;
        if (data.turns.length >= data.total_turns) return;
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
    }, [data?.turns.length, data?.total_turns]);

    return (
        <section className="panel">
            <header>
                <h2>Session inspect</h2>
                <span className="meta">
                    <code>{shortId(decoded)}</code>
                    {" · "}
                    <Link to="/sessions/$sessionId" params={{ sessionId }} style={{ color: "var(--muted, #64748b)" }}>← overview</Link>
                </span>
            </header>
            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {query.isLoading && !data ? <div className="loading">Loading…</div> : null}
            {data ? (
                <>
                    <div style={{ padding: "8px 24px", color: "#64748b", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                        {data.turns.length} turns · {data.total_chars.toLocaleString()} chars · source: <code>{data.source_path}</code>
                    </div>
                    {data.children.length > 0 ? (
                        <div style={{ padding: "6px 24px", background: "#ffe4e6", borderTop: "1px solid #fecdd3", borderBottom: "1px solid #fecdd3", fontSize: 12 }}>
                            <strong style={{ color: "#9f1239" }}>↓ spawned {data.children.length} subagent{data.children.length === 1 ? "" : "s"}</strong>
                            <span style={{ marginLeft: 12, color: "#9f1239", opacity: 0.7 }}>
                                {data.children.slice(0, 6).map((c, i) => {
                                    const bare = bareId(c.session_id);
                                    return (
                                        <span key={c.session_id}>
                                            {i > 0 ? " · " : " "}
                                            <Link
                                                to="/sessions/$sessionId/inspect"
                                                params={{ sessionId: bare }}
                                                style={{ color: "#9f1239", fontFamily: "ui-monospace, monospace" }}
                                            >
                                                {c.nickname ? `"${c.nickname}"` : `${bare.slice(0, 10)}…`}
                                            </Link>
                                        </span>
                                    );
                                })}
                                {data.children.length > 6 ? <span> · …+{data.children.length - 6}</span> : null}
                            </span>
                        </div>
                    ) : null}
                    {data.parent_session ? (
                        <div style={{ padding: "6px 24px", background: "#ffe4e6", borderTop: "1px solid #fecdd3", borderBottom: "1px solid #fecdd3", fontSize: 12 }}>
                            <strong style={{ color: "#9f1239" }}>↑ spawned by</strong>
                            {" "}
                            <Link
                                to="/sessions/$sessionId/inspect"
                                params={{ sessionId: bareId(data.parent_session) }}
                                style={{ color: "#9f1239", fontWeight: 600, fontFamily: "ui-monospace, monospace" }}
                            >
                                {bareId(data.parent_session).slice(0, 12)}…
                            </Link>
                            {data.parent_nickname ? <span style={{ color: "#9f1239", marginLeft: 8 }}>· nickname: <strong>{data.parent_nickname}</strong></span> : null}
                            <span style={{ color: "#9f1239", marginLeft: 8, opacity: 0.7 }}>This is a subagent session.</span>
                        </div>
                    ) : null}
                    <FilterBar
                        turns={data.turns}
                        anchorSeqs={anchorSeqs}
                        currentSeq={anchoredSeq}
                        loadedCount={data.turns.length}
                        totalCount={data.total_turns}
                        appendLoading={appendLoading}
                        loadMore={loadMore}
                        getTurns={() => turnsRef.current}
                        getCurrentSeq={() => anchoredSeqRef.current}
                    />
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 24px 8px" }}>
                        {(Object.keys(KIND_STYLE) as InspectSpanKind[]).map((kind) => {
                            const c = KIND_STYLE[kind];
                            const n = data.totals_by_kind[kind] ?? 0;
                            const pct = data.total_chars > 0 ? ((n / data.total_chars) * 100).toFixed(1) : "0";
                            return (
                                <span key={kind} style={{ background: c.bg, color: c.fg, padding: "2px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, borderLeft: `3px solid ${c.bar}` }}>
                                    {c.label} <em style={{ fontStyle: "normal", opacity: 0.7, fontWeight: 400 }}>{pct}%</em>
                                </span>
                            );
                        })}
                    </div>
                    <div>
                        {(() => {
                            const childrenByTurn = new Map<number, typeof data.children[number][]>();
                            for (const c of data.children) {
                                if (c.anchor_turn_seq == null) continue;
                                const list = childrenByTurn.get(c.anchor_turn_seq) ?? [];
                                list.push(c);
                                childrenByTurn.set(c.anchor_turn_seq, list);
                            }
                            return data.turns.map((t) => (
                                <Turn
                                    key={t.seq}
                                    turn={t}
                                    anchored={anchoredSeq === t.seq}
                                    childrenSpawnedHere={childrenByTurn.get(t.seq)}
                                />
                            ));
                        })()}
                        {data.turns.length < data.total_turns ? (
                            <div
                                ref={sentinelRef}
                                style={{
                                    padding: "12px 24px", color: "#64748b", fontSize: 12, fontFamily: "ui-monospace, monospace",
                                    textAlign: "center", borderTop: "1px dashed #e2e8f0",
                                }}
                            >
                                {appendLoading
                                    ? `loading next ${PAGE_SIZE} of ${data.total_turns.toLocaleString()}…`
                                    : `loaded ${data.turns.length.toLocaleString()} of ${data.total_turns.toLocaleString()} turns ·`}
                                {!appendLoading ? (
                                    <>
                                        {" "}
                                        <button
                                            onClick={() => void loadMore(200)}
                                            style={{
                                                padding: "2px 10px", marginLeft: 6, fontSize: 11, border: "1px solid #e2e8f0",
                                                background: "#fff", color: "#475569", borderRadius: 4, cursor: "pointer",
                                            }}
                                        >load 200 more</button>
                                        {" "}
                                        <button
                                            onClick={() => void loadMore(data.total_turns - data.turns.length)}
                                            style={{
                                                padding: "2px 10px", fontSize: 11, border: "1px solid #e2e8f0",
                                                background: "#fff", color: "#475569", borderRadius: 4, cursor: "pointer",
                                            }}
                                        >load all</button>
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                </>
            ) : null}
        </section>
    );
}
