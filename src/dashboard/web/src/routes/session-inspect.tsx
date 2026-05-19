import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../api.ts";
import type { InspectSpanDto, InspectSpanKind, InspectTurnDto } from "@shared/dashboard-types.ts";

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
    subagent_notification: { bg: "#fed7aa", fg: "#9a3412", bar: "#f97316", label: "subagent" },
    pasted_reference:      { bg: "#fecaca", fg: "#7f1d1d", bar: "#ef4444", label: "pasted" },
};

const shortId = (id: string): string =>
    id.replace(/^session:⟨/, "").replace(/⟩$/, "").slice(0, 12) + "…";

function Span({ span }: { span: InspectSpanDto }) {
    const s = KIND_STYLE[span.kind];
    const title = span.label ? `${s.label}: ${span.label}` : s.label;
    return (
        <span style={{ background: s.bg, color: s.fg, padding: "0 1px", borderRadius: 2 }} title={title}>
            {span.text}
        </span>
    );
}

function Turn({ turn, anchored }: { turn: InspectTurnDto; anchored: boolean }) {
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
        </div>
    );
}

export function SessionInspectRoute() {
    const { sessionId } = useParams({ from: "/sessions/$sessionId/inspect" });
    const decoded = decodeURIComponent(sessionId);
    const query = useQuery({
        queryKey: ["session-inspect", decoded],
        queryFn: () => api.sessionInspect(decoded),
    });
    const data = query.data ?? null;

    // Deep-link to a specific turn via #turn-N (set by URL or page load).
    const anchoredSeq = (() => {
        const m = typeof window !== "undefined" ? window.location.hash.match(/^#turn-(\d+)$/) : null;
        return m ? Number(m[1]) : null;
    })();

    useEffect(() => {
        if (anchoredSeq == null || !data) return;
        const el = document.getElementById(`turn-${anchoredSeq}`);
        if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
    }, [anchoredSeq, data]);

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
                        {data.turns.map((t) => (
                            <Turn key={t.seq} turn={t} anchored={anchoredSeq === t.seq} />
                        ))}
                    </div>
                </>
            ) : null}
        </section>
    );
}
