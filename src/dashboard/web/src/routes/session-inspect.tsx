import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { HookFireDto, InspectSpanDto, InspectSpanKind, InspectTurnDto } from "@shared/dashboard-types.ts";
import { spawnAnchorSet } from "./inspector-filters.ts";
import { spliceHookFires } from "@shared/hook-fire-splice.ts";
import { FilterBar } from "./inspector-filter-bar.tsx";
import { shortSessionId } from "@shared/session-id.ts";

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
    // Wire seam: child.session_id is already bare (see src/lib/shared/session-id.ts).
    const childBare = child.session_id;
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

/** A PreToolUse hook decision spliced into the turn stream. Green vertical
 *  bar matches the existing "hook_injection" span color in KIND_STYLE so the
 *  visual language is consistent. Chips surface inject/reason/event; when
 *  inject=true we also show the clipped titles of the prior-session memory
 *  that landed in the agent's context window. */
function HookFireMarker({ hook }: { hook: HookFireDto }) {
    const ts = hook.ts ? new Date(hook.ts).toISOString().slice(11, 19) : "";
    const injectBg = hook.inject ? "#bbf7d0" : "#e2e8f0";
    const injectFg = hook.inject ? "#065f46" : "#475569";
    const filePathShort = hook.file_path.length > 60
        ? `…${hook.file_path.slice(-58)}`
        : hook.file_path;
    return (
        <div
            id={`hook-${hook.idx}`}
            data-hook-fire="true"
            style={{
                margin: "4px 24px", padding: "6px 10px",
                borderLeft: "3px solid #10b981",
                background: hook.inject ? "#ecfdf5" : "#f8fafc",
                borderRadius: 3, fontSize: 11,
                fontFamily: "ui-monospace, monospace", color: "#065f46",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>⚙ hook_fire</span>
                <span style={{ background: injectBg, color: injectFg, padding: "0 6px", borderRadius: 2, fontSize: 10, fontWeight: 600 }}>
                    inject: {hook.inject ? "yes" : "no"}
                </span>
                <span style={{ background: "#e0e7ff", color: "#3730a3", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                    event: <strong>{hook.event}</strong>
                </span>
                <span style={{ background: "#fef3c7", color: "#92400e", padding: "0 6px", borderRadius: 2, fontSize: 10 }}>
                    reason: <strong>{hook.reason}</strong>
                </span>
                <span style={{ color: "#64748b", fontSize: 10 }}>{hook.latency_ms}ms</span>
                <span style={{ color: "#64748b", marginLeft: "auto" }}>{ts}</span>
            </div>
            <div style={{ marginTop: 3, color: "#475569", fontSize: 11, wordBreak: "break-all" }}>
                {filePathShort}
            </div>
            {hook.inject && hook.injected_titles.length > 0 ? (
                <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px dashed #a7f3d0", fontSize: 10, color: "#065f46" }}>
                    <span style={{ fontWeight: 600 }}>injected memory ({hook.injected_titles.length}):</span>
                    <ul style={{ margin: "2px 0 0 16px", padding: 0 }}>
                        {hook.injected_titles.map((t, i) => (
                            <li key={i} style={{ listStyle: "disc", lineHeight: 1.4 }}>{t}</li>
                        ))}
                    </ul>
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
    // Synchronous re-entrancy guard. `appendLoading` state lags behind rapid
    // async callers (IntersectionObserver + jump button can both pass the
    // state check before React commits), so we flip a ref synchronously and
    // gate on that.
    const loadingRef = useRef(false);

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
        // Synchronous ref check beats `appendLoading` state which is stale
        // across rapid back-to-back callers in the same tick.
        if (loadingRef.current) return;
        loadingRef.current = true;
        setAppendLoading(true);
        try {
            const page = await api.sessionInspect(decoded, {
                turnOffset: data.turns.length,
                turnLimit: count,
            });
            queryClient.setQueryData<typeof data>(baseKey, (prev) => {
                if (!prev) return prev;
                // Hook fires are server-windowed by the turn slice ts range,
                // so each page returns a different subset. Merge by idx
                // (stable across pages) and re-sort to keep render order
                // deterministic.
                const byIdx = new Map<number, typeof prev.hook_fires[number]>();
                for (const h of prev.hook_fires) byIdx.set(h.idx, h);
                for (const h of page.hook_fires) byIdx.set(h.idx, h);
                const mergedHooks = [...byIdx.values()].sort((a, b) => a.idx - b.idx);
                return {
                    ...prev,
                    turns: [...prev.turns, ...page.turns],
                    turn_window: { offset: 0, limit: prev.turns.length + page.turns.length },
                    hook_fires: mergedHooks,
                };
            });
        } finally {
            loadingRef.current = false;
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
    const hookFireIdxsRef = useRef<ReadonlyArray<number>>([]);
    hookFireIdxsRef.current = data?.hook_fires.map((h) => h.idx) ?? [];

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
                    <code>{shortSessionId(decoded)}…</code>
                    {" · "}
                    <Link to="/sessions/$sessionId" params={{ sessionId }} style={{ color: "var(--muted, #64748b)" }}>← overview</Link>
                </span>
            </header>
            {query.error ? <div className="error">Error: {String(query.error)}</div> : null}
            {query.isLoading && !data ? <div className="loading">Loading…</div> : null}
            {data ? (
                <>
                    <div style={{ padding: "8px 24px", color: "#64748b", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                        {data.turns.length} turns · {data.total_chars.toLocaleString()} chars
                        {data.total_hook_fires > 0 ? (
                            <> · <span style={{ color: "#065f46" }}>{data.total_hook_fires} hook decision{data.total_hook_fires === 1 ? "" : "s"}</span></>
                        ) : null}
                        {" · source: "}<code>{data.source_path}</code>
                    </div>
                    {data.children.length > 0 ? (
                        <div style={{ padding: "6px 24px", background: "#ffe4e6", borderTop: "1px solid #fecdd3", borderBottom: "1px solid #fecdd3", fontSize: 12 }}>
                            <strong style={{ color: "#9f1239" }}>↓ spawned {data.children.length} subagent{data.children.length === 1 ? "" : "s"}</strong>
                            <span style={{ marginLeft: 12, color: "#9f1239", opacity: 0.7 }}>
                                {data.children.slice(0, 6).map((c, i) => {
                                    // Wire seam: c.session_id is already bare.
                                    const bare = c.session_id;
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
                                params={{ sessionId: data.parent_session }}
                                style={{ color: "#9f1239", fontWeight: 600, fontFamily: "ui-monospace, monospace" }}
                            >
                                {shortSessionId(data.parent_session)}…
                            </Link>
                            {data.parent_nickname ? <span style={{ color: "#9f1239", marginLeft: 8 }}>· nickname: <strong>{data.parent_nickname}</strong></span> : null}
                            <span style={{ color: "#9f1239", marginLeft: 8, opacity: 0.7 }}>This is a subagent session.</span>
                        </div>
                    ) : null}
                    <FilterBar
                        turns={data.turns}
                        anchorSeqs={anchorSeqs}
                        loadedCount={data.turns.length}
                        totalCount={data.total_turns}
                        appendLoading={appendLoading}
                        loadMore={loadMore}
                        getTurns={() => turnsRef.current}
                        getCurrentSeq={() => anchoredSeqRef.current}
                        hookFireIdxs={data.hook_fires.map((h) => h.idx)}
                        getHookFireIdxs={() => hookFireIdxsRef.current}
                        totalHookFires={data.total_hook_fires}
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
                            const items = spliceHookFires(data.turns, data.hook_fires);
                            return items.map((item) => {
                                if (item.kind === "hook_fire") {
                                    return <HookFireMarker key={`hook-${item.hook.idx}`} hook={item.hook} />;
                                }
                                const t = item.turn;
                                return (
                                    <Turn
                                        key={`turn-${t.seq}`}
                                        turn={t}
                                        anchored={anchoredSeq === t.seq}
                                        childrenSpawnedHere={childrenByTurn.get(t.seq)}
                                    />
                                );
                            });
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
